import { invoke } from "@tauri-apps/api/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/ctx";
import { gapCursor } from "@milkdown/prose/gapcursor";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorView, NodeView } from "@milkdown/prose/view";
import { $ctx, $nodeSchema, $prose, $remark, $view } from "@milkdown/utils";
import {
  ASSET_IMPORT_STATUS_DOM_EVENT,
  getAttachmentImportState,
  type AttachmentImportState,
} from "./attachmentImportState";

const ATTACHMENT_DATA_TYPE = "attachment-block";

type AttachmentMarkdownNode = {
  type: "attachment";
  url: string;
  title?: string | null;
  label?: string | null;
};

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  label?: string | null;
  children?: MarkdownNode[];
};

type LocalAssetMetadata = {
  fileName: string;
  sizeBytes: number;
  modifiedUnixMs: number | null;
  extension: string | null;
};

export type AttachmentBlockConfig = {
  getDocumentPath: () => string | null;
  getRevealLocalPathLabel: () => string;
  getImportingLabel: () => string;
  getImportFailedLabel: () => string;
  openLocalPath: (path: string, label?: string) => Promise<void>;
  revealLocalPath: (path: string, label?: string) => Promise<void>;
};

const defaultAttachmentBlockConfig: AttachmentBlockConfig = {
  getDocumentPath: () => null,
  getRevealLocalPathLabel: () => "Open File Location",
  getImportingLabel: () => "Importing...",
  getImportFailedLabel: () => "Import failed",
  openLocalPath: async () => undefined,
  revealLocalPath: async () => undefined,
};

const attachmentMetadataCache = new Map<string, LocalAssetMetadata>();
const pendingAttachmentMetadata = new Map<string, Promise<LocalAssetMetadata | null>>();
let closeActiveAttachmentContextMenu: (() => void) | null = null;

export const attachmentBlockConfig = $ctx(
  defaultAttachmentBlockConfig,
  "attachmentBlockConfigCtx",
);

const isImagePath = (value: string) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(value);

const isMarkdownPath = (value: string) => /\.(md|markdown)$/i.test(value);

const getPathFileName = (value: string) => value.split(/[\\/]/).pop() ?? value;

const compoundAttachmentExtensions = [
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "tar.zst",
  "user.js",
  "user.css",
] as const;

const archiveExtensions = new Set([
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "tar.zst",
  "cab",
  "iso",
]);

const wordExtensions = new Set([
  "doc",
  "docx",
  "odt",
  "rtf",
  "pages",
]);

const spreadsheetExtensions = new Set([
  "xls",
  "xlsx",
  "ods",
  "numbers",
  "csv",
]);

const presentationExtensions = new Set([
  "ppt",
  "pptx",
  "odp",
  "key",
]);

const documentExtensions = new Set([
  ...wordExtensions,
  ...spreadsheetExtensions,
  ...presentationExtensions,
]);

const textExtensions = new Set([
  "txt",
  "text",
  "md",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "java",
  "kt",
  "go",
  "rs",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "swift",
  "sql",
  "log",
  "ini",
  "toml",
  "conf",
  "cfg",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "zsh",
  "fish",
]);

const mediaExtensions = new Set([
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "wmv",
  "m4v",
]);

const packageExtensions = new Set([
  "exe",
  "msi",
  "apk",
  "ipa",
  "dmg",
  "pkg",
  "appimage",
  "deb",
  "rpm",
]);

const getAttachmentExtension = (value: string) => {
  const fileName = getPathFileName(value);
  const normalized = fileName.toLowerCase();
  const compoundExtension = compoundAttachmentExtensions.find((extension) =>
    normalized.endsWith(`.${extension}`),
  );
  if (compoundExtension) {
    return compoundExtension;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return "";
  }

  return fileName.slice(lastDot + 1).toLowerCase();
};

const attachmentBadgeAliases = new Map<string, string>([
  ["tar.gz", "TGZ"],
  ["tar.bz2", "TBZ2"],
  ["tar.xz", "TXZ"],
  ["tar.zst", "TZST"],
  ["user.js", "JS"],
  ["user.css", "CSS"],
]);

const formatAttachmentBadge = (extension: string) => {
  const alias = attachmentBadgeAliases.get(extension);
  if (alias) {
    return alias;
  }

  const normalized = extension.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized.slice(0, 4) || "FILE";
};

const getAttachmentTone = (extension: string) => {
  if (archiveExtensions.has(extension)) {
    return "archive";
  }

  if (extension === "pdf") {
    return "pdf";
  }

  if (documentExtensions.has(extension)) {
    return "document";
  }

  if (mediaExtensions.has(extension)) {
    return "media";
  }

  if (textExtensions.has(extension)) {
    return "text";
  }

  if (packageExtensions.has(extension)) {
    return "package";
  }

  return "file";
};

const getAttachmentIcon = (extension: string) => {
  if (!extension) {
    return "FILE";
  }

  if (archiveExtensions.has(extension)) {
    if (extension === "rar") {
      return "RAR";
    }

    if (extension === "7z") {
      return "7Z";
    }

    return "ZIP";
  }

  if (extension === "pdf") {
    return "PDF";
  }

  if (wordExtensions.has(extension)) {
    return "DOC";
  }

  if (spreadsheetExtensions.has(extension)) {
    return "XLS";
  }

  if (presentationExtensions.has(extension)) {
    return "PPT";
  }

  return formatAttachmentBadge(extension);
};

const formatAttachmentSize = (sizeBytes: number) => {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const sizeKb = sizeBytes / 1024;
  if (sizeKb < 1024) {
    return `${sizeKb >= 100 ? Math.round(sizeKb) : sizeKb.toFixed(1)} KB`;
  }

  const sizeMb = sizeKb / 1024;
  if (sizeMb < 1024) {
    return `${sizeMb >= 100 ? Math.round(sizeMb) : sizeMb.toFixed(1)} MB`;
  }

  return `${(sizeMb / 1024).toFixed(1)} GB`;
};

const formatAttachmentModifiedAt = (modifiedUnixMs: number | null) => {
  if (!modifiedUnixMs) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(modifiedUnixMs));
};

const resolveRelativePath = (baseFilePath: string, relativePath: string) => {
  const normalizedBase = baseFilePath.replace(/\\/g, "/");
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const baseParts = normalizedBase.split("/");
  baseParts.pop();

  for (const segment of normalizedRelative.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (baseParts.length > 1 || (baseParts.length === 1 && baseParts[0] !== "")) {
        baseParts.pop();
      }
      continue;
    }

    baseParts.push(segment);
  }

  if (normalizedBase.startsWith("/")) {
    return `/${baseParts.filter(Boolean).join("/")}`;
  }

  return baseParts.join("/");
};

const resolveAttachmentPath = (source: string, documentPath: string | null) => {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }

  let normalizedSource = trimmed;
  try {
    normalizedSource = decodeURIComponent(trimmed);
  } catch {
    normalizedSource = trimmed;
  }

  if (
    /^(?:https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(normalizedSource) ||
    normalizedSource.startsWith("//")
  ) {
    return normalizedSource;
  }

  if (/^[a-zA-Z]:[\\/]/.test(normalizedSource) || normalizedSource.startsWith("/")) {
    return normalizedSource;
  }

  if (!documentPath) {
    return null;
  }

  return resolveRelativePath(documentPath, normalizedSource);
};

const isAttachmentUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return false;
  }

  let normalizedValue = trimmed;
  try {
    normalizedValue = decodeURIComponent(trimmed);
  } catch {
    normalizedValue = trimmed;
  }

  if (
    /^(?:https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(normalizedValue) ||
    normalizedValue.startsWith("//")
  ) {
    return false;
  }

  return !isImagePath(normalizedValue) && !isMarkdownPath(normalizedValue);
};

const extractTextContent = (nodes: MarkdownNode[] | undefined): string => {
  if (!nodes || nodes.length === 0) {
    return "";
  }

  return nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value ?? "";
      }

      return extractTextContent(node.children);
    })
    .join("")
    .trim();
};

const canPromoteAttachmentParagraph = (parentType: string) =>
  parentType === "root" || parentType === "blockquote";

const toAttachmentMarkdownNode = (
  node: MarkdownNode,
  parentType: string,
): AttachmentMarkdownNode | null => {
  if (!canPromoteAttachmentParagraph(parentType) || node.type !== "paragraph") {
    return null;
  }

  const children = node.children ?? [];
  if (children.length !== 1) {
    return null;
  }

  const link = children[0];
  if (link.type !== "link" || !link.url || !isAttachmentUrl(link.url)) {
    return null;
  }

  const label = extractTextContent(link.children) || getPathFileName(link.url);
  return {
    type: "attachment",
    url: link.url,
    title: link.title ?? null,
    label,
  };
};

const transformAttachmentParagraphs = (node: MarkdownNode) => {
  const children = node.children;
  if (!children || children.length === 0) {
    return;
  }

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const attachmentNode = toAttachmentMarkdownNode(child, node.type);
    if (attachmentNode) {
      children[index] = attachmentNode;
      continue;
    }

    transformAttachmentParagraphs(child);
  }
};

const readAttachmentMetadata = async (path: string) => {
  const cached = attachmentMetadataCache.get(path);
  if (cached) {
    return cached;
  }

  const pending = pendingAttachmentMetadata.get(path);
  if (pending) {
    return pending;
  }

  const loadTask = invoke<LocalAssetMetadata>("read_local_asset_metadata", {
    path,
  })
    .then((metadata) => {
      attachmentMetadataCache.set(path, metadata);
      return metadata;
    })
    .catch(() => null)
    .finally(() => {
      pendingAttachmentMetadata.delete(path);
    });

  pendingAttachmentMetadata.set(path, loadTask);
  return loadTask;
};

export const remarkAttachmentBlockPlugin = $remark(
  "remark-attachment-block",
  () => () => (tree) => {
    transformAttachmentParagraphs(tree as MarkdownNode);
  },
);

export const attachmentBlockSchema = $nodeSchema("attachment", () => ({
  group: "block",
  selectable: true,
  draggable: false,
  isolating: true,
  atom: true,
  marks: "",
  priority: 99,
  attrs: {
    src: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
    title: { default: null, validate: "string|null" },
  },
  parseDOM: [
    {
      tag: `div[data-type="${ATTACHMENT_DATA_TYPE}"]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) {
          return false;
        }

        return {
          src: dom.getAttribute("data-src") ?? "",
          label: dom.getAttribute("data-label") ?? "",
          title: dom.getAttribute("data-title"),
        };
      },
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-type": ATTACHMENT_DATA_TYPE,
      "data-src": String(node.attrs.src ?? ""),
      "data-label": String(node.attrs.label ?? ""),
      "data-title":
        typeof node.attrs.title === "string" ? String(node.attrs.title) : null,
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === "attachment",
    runner: (state, node, type) => {
      const attachment = node as AttachmentMarkdownNode;
      state.addNode(type, {
        src: attachment.url,
        label: attachment.label ?? getPathFileName(attachment.url),
        title: attachment.title ?? null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "attachment",
    runner: (state, node) => {
      const src = String(node.attrs.src ?? "");
      const label =
        String(node.attrs.label ?? "").trim() || getPathFileName(src) || "attachment";

      state.openNode("paragraph");
      state.addNode(
        "link",
        [{ type: "text", value: label }],
        undefined,
        {
          title: node.attrs.title,
          url: src,
        },
      );
      state.closeNode();
    },
  },
}));

const attachmentInteractionKey = new PluginKey("attachment-block-interaction");

const getAttachmentSurfaceRect = (view: EditorView, nodePos: number) => {
  const nodeDom = view.nodeDOM(nodePos);
  if (!(nodeDom instanceof HTMLElement)) {
    return null;
  }

  const surface = nodeDom.querySelector<HTMLElement>(".tinymd-attachment-block__surface");
  return (surface ?? nodeDom).getBoundingClientRect();
};

const resolveAttachmentFromNode = (
  node: ProseNode,
  config: AttachmentBlockConfig,
) => resolveAttachmentPath(String(node.attrs.src ?? ""), config.getDocumentPath());

export const attachmentBlockInteractionPlugin = $prose((ctx) => {
  const config = ctx.get(attachmentBlockConfig.key);

  return new Plugin({
    key: attachmentInteractionKey,
    props: {
      handleClickOn: (view, _pos, node, nodePos, event, direct) => {
        if (
          !direct ||
          node.type.name !== "attachment" ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return false;
        }

        const rect = getAttachmentSurfaceRect(view, nodePos);
        if (!rect) {
          return false;
        }

        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          return false;
        }

        const documentPath = config.getDocumentPath();
        const importState = getAttachmentImportState(documentPath, String(node.attrs.src ?? ""));
        if (importState?.status === "queued" || importState?.status === "failed") {
          event.preventDefault();
          return true;
        }

        const resolvedPath = resolveAttachmentFromNode(node, config);
        if (!resolvedPath) {
          return false;
        }

        event.preventDefault();
        void config
          .openLocalPath(resolvedPath, String(node.attrs.label ?? "").trim() || undefined)
          .catch((error) => {
            console.error("Failed to open attachment", error);
          });
        return true;
      },
      handleDoubleClickOn: (view, _pos, node, nodePos, event, direct) => {
        return direct && node.type.name === "attachment" && event.button === 0;
      },
    },
  });
});

export const attachmentGapCursorPlugin = $prose(() => gapCursor());

class AttachmentBlockView implements NodeView {
  node: ProseNode;
  readonly view: EditorView;
  readonly getPos: () => number | undefined;
  readonly dom: HTMLDivElement;

  readonly #config: AttachmentBlockConfig;
  readonly #surface: HTMLDivElement;
  readonly #contextMenu: HTMLDivElement;
  readonly #revealButton: HTMLButtonElement;
  readonly #icon: HTMLSpanElement;
  readonly #title: HTMLSpanElement;
  readonly #meta: HTMLSpanElement;
  #metadata: LocalAssetMetadata | null = null;
  #metadataPath: string | null = null;
  #metadataRetryTimer: number | null = null;
  #metadataRetryAttempts = 0;
  #resolvedPath: string | null = null;
  #selected = false;
  #contextMenuOpen = false;

  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined,
    config: AttachmentBlockConfig,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.#config = config;

    this.dom = document.createElement("div");
    this.dom.className = "tinymd-attachment-block";
    this.dom.contentEditable = "false";

    this.#surface = document.createElement("div");
    this.#surface.className = "tinymd-attachment-block__surface";
    this.#surface.contentEditable = "false";
    this.#contextMenu = document.createElement("div");
    this.#contextMenu.className = "attachment-context-menu";
    this.#contextMenu.hidden = true;

    this.#revealButton = document.createElement("button");
    this.#revealButton.type = "button";
    this.#revealButton.className = "attachment-context-menu__item";

    this.#icon = document.createElement("span");
    this.#icon.className = "tinymd-attachment-block__icon";
    this.#icon.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "tinymd-attachment-block__body";

    this.#title = document.createElement("span");
    this.#title.className = "tinymd-attachment-block__title";

    this.#meta = document.createElement("span");
    this.#meta.className = "tinymd-attachment-block__meta";

    body.append(this.#title, this.#meta);
    this.#surface.append(this.#icon, body);
    this.dom.append(this.#surface);
    this.#contextMenu.append(this.#revealButton);

    this.#surface.addEventListener("mousedown", this.#handleSurfaceMouseDown);
    this.#surface.addEventListener("click", this.#handleSurfaceClick);
    this.dom.addEventListener("contextmenu", this.#handleContextMenu);
    this.#contextMenu.addEventListener("pointerdown", this.#handleMenuPointerDown);
    this.#revealButton.addEventListener("click", this.#handleRevealClick);
    window.addEventListener(ASSET_IMPORT_STATUS_DOM_EVENT, this.#handleAssetImportStatus as EventListener);

    this.#render();
    void this.#syncMetadata();
  }

  update(node: ProseNode) {
    if (node.type.name !== this.node.type.name) {
      return false;
    }

    const previousSrc = String(this.node.attrs.src ?? "");
    this.node = node;
    if (String(node.attrs.src ?? "") !== previousSrc) {
      this.#metadata = null;
      this.#metadataPath = null;
      this.#metadataRetryAttempts = 0;
      this.#clearMetadataRetry();
    }
    this.#render();
    void this.#syncMetadata();
    return true;
  }

  selectNode() {
    this.#selected = true;
    this.dom.classList.add("is-selected", "ProseMirror-selectednode");
  }

  deselectNode() {
    this.#selected = false;
    this.dom.classList.remove("is-selected", "ProseMirror-selectednode");
  }

  stopEvent(event: Event) {
    const target = event.target as Node | null;
    if (target && this.#contextMenu.contains(target)) {
      return true;
    }

    if (
      target &&
      this.#surface.contains(target) &&
      (event.type === "mousedown" || event.type === "click")
    ) {
      return true;
    }

    return event.type === "contextmenu" && Boolean(target && this.dom.contains(target));
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.#clearMetadataRetry();
    this.#closeContextMenu();
    this.#surface.removeEventListener("mousedown", this.#handleSurfaceMouseDown);
    this.#surface.removeEventListener("click", this.#handleSurfaceClick);
    this.dom.removeEventListener("contextmenu", this.#handleContextMenu);
    this.#contextMenu.removeEventListener("pointerdown", this.#handleMenuPointerDown);
    this.#revealButton.removeEventListener("click", this.#handleRevealClick);
    window.removeEventListener(
      ASSET_IMPORT_STATUS_DOM_EVENT,
      this.#handleAssetImportStatus as EventListener,
    );
    this.#contextMenu.remove();
  }

  readonly #handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.#selectNodeInEditor();

    if (!this.#resolvedPath || this.#getImportState()?.status) {
      return;
    }

    this.#openContextMenu(event.clientX, event.clientY);
  };

  readonly #handleSurfaceMouseDown = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.#selectNodeInEditor();
  };

  readonly #handleSurfaceClick = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.#selectNodeInEditor();

    if (!this.#resolvedPath || this.#getImportState()?.status) {
      return;
    }

    void this.#config
      .openLocalPath(this.#resolvedPath, this.#title.textContent ?? undefined)
      .catch((error) => {
        console.error("Failed to open attachment", error);
      });
  };

  readonly #handleMenuPointerDown = (event: PointerEvent) => {
    event.stopPropagation();
  };

  readonly #handleRevealClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.#closeContextMenu();
    this.#selectNodeInEditor();

    if (!this.#resolvedPath || this.#getImportState()?.status) {
      return;
    }

    void this.#config
      .revealLocalPath(this.#resolvedPath, this.#title.textContent ?? undefined)
      .catch((error) => {
        console.error("Failed to reveal attachment location", error);
      });
  };

  readonly #handleWindowPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && this.#contextMenu.contains(target)) {
      return;
    }

    this.#closeContextMenu();
  };

  readonly #handleWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.#closeContextMenu();
    }
  };

  readonly #handleWindowBlur = () => {
    this.#closeContextMenu();
  };

  readonly #handleWindowResize = () => {
    this.#closeContextMenu();
  };

  readonly #handleWindowScroll = () => {
    this.#closeContextMenu();
  };

  #getImportState() {
    return getAttachmentImportState(
      this.#config.getDocumentPath(),
      String(this.node.attrs.src ?? ""),
    );
  }

  readonly #handleAssetImportStatus = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }

    const detail = event.detail as AttachmentImportState | undefined;
    if (
      !detail ||
      detail.relativePath !== String(this.node.attrs.src ?? "") ||
      detail.documentPath !== this.#config.getDocumentPath()
    ) {
      return;
    }

    this.#metadata = null;
    this.#metadataPath = null;
    this.#metadataRetryAttempts = 0;
    this.#clearMetadataRetry();
    void this.#syncMetadata();
  };

  #clearMetadataRetry() {
    if (this.#metadataRetryTimer === null) {
      return;
    }

    window.clearTimeout(this.#metadataRetryTimer);
    this.#metadataRetryTimer = null;
  }

  #scheduleMetadataRetry() {
    if (this.#metadataRetryTimer !== null || this.#metadataRetryAttempts >= 20) {
      return;
    }

    this.#metadataRetryAttempts += 1;
    this.#metadataRetryTimer = window.setTimeout(() => {
      this.#metadataRetryTimer = null;
      void this.#syncMetadata();
    }, 1000);
  }

  #selectNodeInEditor() {
    const pos = this.getPos();
    if (typeof pos !== "number") {
      return;
    }

    const selection = NodeSelection.create(this.view.state.doc, pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    if (!this.view.hasFocus()) {
      this.view.focus();
    }
  }

  #openContextMenu(clientX: number, clientY: number) {
    closeActiveAttachmentContextMenu?.();
    closeActiveAttachmentContextMenu = this.#closeContextMenu;

    if (!this.#contextMenu.isConnected) {
      document.body.append(this.#contextMenu);
    }

    this.#revealButton.textContent = this.#config.getRevealLocalPathLabel();
    this.#contextMenu.hidden = false;
    this.#contextMenu.style.left = `${clientX}px`;
    this.#contextMenu.style.top = `${clientY}px`;

    const menuRect = this.#contextMenu.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - menuRect.width - 8);
    const top = Math.min(clientY, window.innerHeight - menuRect.height - 8);
    this.#contextMenu.style.left = `${Math.max(8, left)}px`;
    this.#contextMenu.style.top = `${Math.max(8, top)}px`;
    this.#contextMenuOpen = true;

    window.addEventListener("pointerdown", this.#handleWindowPointerDown, true);
    window.addEventListener("keydown", this.#handleWindowKeyDown, true);
    window.addEventListener("blur", this.#handleWindowBlur);
    window.addEventListener("resize", this.#handleWindowResize);
    window.addEventListener("scroll", this.#handleWindowScroll, true);
  }

  #closeContextMenu = () => {
    if (!this.#contextMenuOpen) {
      if (closeActiveAttachmentContextMenu === this.#closeContextMenu) {
        closeActiveAttachmentContextMenu = null;
      }
      return;
    }

    this.#contextMenuOpen = false;
    this.#contextMenu.hidden = true;

    window.removeEventListener("pointerdown", this.#handleWindowPointerDown, true);
    window.removeEventListener("keydown", this.#handleWindowKeyDown, true);
    window.removeEventListener("blur", this.#handleWindowBlur);
    window.removeEventListener("resize", this.#handleWindowResize);
    window.removeEventListener("scroll", this.#handleWindowScroll, true);

    if (closeActiveAttachmentContextMenu === this.#closeContextMenu) {
      closeActiveAttachmentContextMenu = null;
    }
  };

  async #syncMetadata() {
    const resolvedPath = this.#getResolvedPath();
    const importState = this.#getImportState();
    if (importState?.status === "queued" || importState?.status === "failed") {
      this.#clearMetadataRetry();
      this.#metadataRetryAttempts = 0;
      this.#metadata = null;
      this.#metadataPath = null;
      this.#render();
      return;
    }

    if (!resolvedPath || /^(?:https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(resolvedPath)) {
      this.#clearMetadataRetry();
      this.#metadataRetryAttempts = 0;
      this.#metadata = null;
      this.#metadataPath = null;
      this.#render();
      return;
    }

    const metadata = await readAttachmentMetadata(resolvedPath);
    if (resolvedPath !== this.#getResolvedPath()) {
      return;
    }

    this.#metadata = metadata;
    this.#metadataPath = resolvedPath;
    if (metadata) {
      this.#clearMetadataRetry();
      this.#metadataRetryAttempts = 0;
    } else {
      this.#scheduleMetadataRetry();
    }
    this.#render();
  }

  #getResolvedPath() {
    const src = String(this.node.attrs.src ?? "");
    this.#resolvedPath = resolveAttachmentPath(src, this.#config.getDocumentPath());
    return this.#resolvedPath;
  }

  #render() {
    const src = String(this.node.attrs.src ?? "");
    const label = String(this.node.attrs.label ?? "").trim();
    const resolvedPath = this.#getResolvedPath();
    const importState = this.#getImportState();
    if (resolvedPath !== this.#metadataPath) {
      this.#metadata = null;
    }
    const extension = getAttachmentExtension(
      this.#metadata?.fileName || resolvedPath || src,
    );
    const title =
      this.#metadata?.fileName || label || getPathFileName(resolvedPath ?? src) || "attachment";
    const metaText =
      importState?.status === "queued"
        ? this.#config.getImportingLabel()
        : importState?.status === "failed"
          ? this.#config.getImportFailedLabel()
          : [
              formatAttachmentModifiedAt(this.#metadata?.modifiedUnixMs ?? null),
              this.#metadata ? formatAttachmentSize(this.#metadata.sizeBytes) : null,
            ].filter((part): part is string => Boolean(part)).join(", ") ||
            (extension ? extension.toUpperCase() : "Attachment");

    this.dom.dataset.attachmentTone = getAttachmentTone(extension);
    this.dom.dataset.attachmentPath = resolvedPath ?? src;
    if (importState?.status) {
      this.dom.dataset.importStatus = importState.status;
    } else {
      delete this.dom.dataset.importStatus;
    }
    this.#icon.textContent = getAttachmentIcon(extension);
    this.#title.textContent = title;
    this.#meta.textContent = metaText;
    this.#surface.title = [title, metaText].filter(Boolean).join("\n");
    this.#surface.setAttribute("aria-label", title);
    this.#revealButton.textContent = this.#config.getRevealLocalPathLabel();

    if (this.#selected) {
      this.dom.classList.add("is-selected", "ProseMirror-selectednode");
    } else {
      this.dom.classList.remove("is-selected", "ProseMirror-selectednode");
    }
  }
}

export const attachmentBlockView = $view(attachmentBlockSchema.node, (ctx: Ctx) => {
  const config = ctx.get(attachmentBlockConfig.key);
  return (node, view, getPos) => new AttachmentBlockView(node, view, getPos, config);
});

export const attachmentBlockComponent = [
  attachmentBlockConfig,
  remarkAttachmentBlockPlugin,
  attachmentBlockSchema,
  attachmentGapCursorPlugin,
  attachmentBlockInteractionPlugin,
  attachmentBlockView,
].flat() as MilkdownPlugin[];
