import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

/**
 * 文档导出工具：把当前已渲染的 Milkdown 文档内容导出为 PDF 或 PNG。
 *
 * 实现说明（见 docs/editor-architecture.md）：
 * - 渲染基于 html2canvas：它直接读取 DOM 手动绘制到 canvas，不依赖 SVG foreignObject，
 *   因此在 macOS WKWebView 下能正常出图（foreignObject 方案在 WKWebView 会得到空白图）。
 * - PDF 由 jsPDF 把 canvas 分页拼成；WKWebView 的 window.print() 基本不可用，故不走打印。
 * - 不直接使用实时编辑器 DOM，而是克隆已渲染内容并剥离编辑器专属元素（block handle、
 *   slash menu、占位符等），保证导出结果干净且与所见一致。
 * - 图片此时已被编辑器解析为 data: URL，导出能直接带图。
 * - webview 原生缩放不会改变 DOM 布局值，导出排版固定、不受当前缩放影响。
 */

// 导出页面宽度，约等于 A4 96dpi 正文宽度，保证 PDF 与图片排版稳定一致。
const EXPORT_PAGE_WIDTH = 794;
// canvas 渲染倍率，2 倍保证清晰度。
const EXPORT_SCALE = 2;

const EDITOR_ONLY_SELECTORS = [
  ".tinymd-block-handle",
  ".milkdown-block-handle",
  ".milkdown-slash-menu",
  ".milkdown-tooltip",
  ".ProseMirror-gapcursor",
  ".crepe-placeholder",
  "[data-tinymd-handle]",
].join(",");

/** 找到承载已渲染文档内容的节点。 */
const findContentNode = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(".ProseMirror") ??
  root.querySelector<HTMLElement>(".milkdown") ??
  null;

/**
 * mac 上编辑器禁用了原生列表 marker，改用 CSS 自绘，相关样式作用域是
 * `.editor-shell.uses-mac-custom-list-view`。导出容器必须复制这些 class，
 * 否则 mac 下导出的列表会丢失序号 / 圆点 / 勾选框。
 */
const getShellClassName = (root: HTMLElement): string => {
  const shell = root.querySelector<HTMLElement>(".editor-shell");
  const usesMacCustomList = shell?.classList.contains(
    "uses-mac-custom-list-view",
  );
  return usesMacCustomList
    ? "editor-shell uses-mac-custom-list-view"
    : "editor-shell";
};

/** 克隆文档内容并剥离编辑器专属元素。 */
const cloneCleanContent = (root: HTMLElement): HTMLElement | null => {
  const content = findContentNode(root);
  if (!content) {
    return null;
  }

  const clone = content.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(EDITOR_ONLY_SELECTORS).forEach((node) => node.remove());
  clone.removeAttribute("contenteditable");
  clone
    .querySelectorAll<HTMLElement>("[contenteditable]")
    .forEach((node) => node.removeAttribute("contenteditable"));
  return clone;
};

/**
 * 创建一个离屏导出容器并把干净内容挂上去。容器放在视口左上角、置于最底层（被
 * 不透明的应用界面遮住，用户看不到），但 html2canvas 仍能正常渲染它的子树。
 * 调用方负责移除。
 */
const createExportSurface = (
  clone: HTMLElement,
  shellClassName: string,
): HTMLElement => {
  const surface = document.createElement("div");
  surface.className = `tinymd-export-surface ${shellClassName}`;
  // 用 absolute（而非 fixed），让容器在文档流中拥有完整高度，
  // 否则 html2canvas 会按窗口可视高度裁剪，导出只剩当前视图内容。
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = "0";
  surface.style.zIndex = "-1";
  surface.style.width = `${EXPORT_PAGE_WIDTH}px`;
  surface.style.padding = "48px";
  surface.style.background = "#ffffff";
  surface.style.color = "#1a1a1a";
  surface.style.overflow = "visible";
  surface.style.boxSizing = "border-box";
  surface.style.pointerEvents = "none";

  const inner = document.createElement("div");
  inner.className = "milkdown";
  inner.appendChild(clone);
  surface.appendChild(inner);

  return surface;
};

/** 把编辑器内容渲染成 canvas。失败或无内容返回 null。 */
const renderToCanvas = async (
  editorRoot: HTMLElement,
): Promise<HTMLCanvasElement | null> => {
  const clone = cloneCleanContent(editorRoot);
  if (!clone) {
    return null;
  }

  const surface = createExportSurface(clone, getShellClassName(editorRoot));
  document.body.appendChild(surface);

  try {
    // 等待一帧，确保样式与图片布局完成。
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => resolve(null)),
    );

    // 显式传入容器的完整尺寸，确保 html2canvas 渲染整篇文档而非仅可视区域。
    const fullWidth = Math.ceil(surface.scrollWidth);
    const fullHeight = Math.ceil(surface.scrollHeight);

    const canvas = await html2canvas(surface, {
      scale: EXPORT_SCALE,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      width: fullWidth,
      height: fullHeight,
      windowWidth: fullWidth,
      windowHeight: fullHeight,
      scrollX: 0,
      scrollY: 0,
    });
    return canvas;
  } finally {
    surface.remove();
  }
};

const dataUrlToBytes = (dataUrl: string): Uint8Array => {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** 导出为 PNG，返回 PNG 字节；无内容返回 null。 */
export const renderToPngBytes = async (
  editorRoot: HTMLElement,
): Promise<Uint8Array | null> => {
  const canvas = await renderToCanvas(editorRoot);
  if (!canvas) {
    return null;
  }
  return dataUrlToBytes(canvas.toDataURL("image/png"));
};

/**
 * 导出为 PDF，返回 PDF 字节；无内容返回 null。
 *
 * 把整张内容图按页面可用区高度逐页“切片”，每页放一张独立的切片图。
 * 相比“整图按偏移叠放”的做法，逐页切片不会在页边距处重叠 → 不会出现内容重复/黑边。
 */
export const renderToPdfBytes = async (
  editorRoot: HTMLElement,
): Promise<Uint8Array | null> => {
  const canvas = await renderToCanvas(editorRoot);
  if (!canvas) {
    return null;
  }

  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const margin = 12; // mm
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;

  // 画布像素 → 毫米 的换算（按宽度铺满可用区）。
  const pxPerMm = canvas.width / usableWidth;
  const pageSlicePx = Math.max(1, Math.floor(usableHeight * pxPerMm));

  let renderedPx = 0;
  let firstPage = true;

  while (renderedPx < canvas.height) {
    const slicePx = Math.min(pageSlicePx, canvas.height - renderedPx);

    const sliceCanvas = document.createElement("canvas");
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = slicePx;
    const ctx = sliceCanvas.getContext("2d");
    if (!ctx) {
      break;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    ctx.drawImage(
      canvas,
      0,
      renderedPx,
      canvas.width,
      slicePx,
      0,
      0,
      canvas.width,
      slicePx,
    );

    const sliceData = sliceCanvas.toDataURL("image/png");
    const sliceHeightMm = slicePx / pxPerMm;

    if (!firstPage) {
      pdf.addPage();
    }
    pdf.addImage(sliceData, "PNG", margin, margin, usableWidth, sliceHeightMm);

    firstPage = false;
    renderedPx += slicePx;
  }

  const buffer = pdf.output("arraybuffer");
  return new Uint8Array(buffer);
};
