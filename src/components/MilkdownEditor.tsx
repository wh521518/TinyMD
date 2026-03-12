import "@milkdown/crepe/theme/common/style.css";
import { parserCtx, schemaCtx } from "@milkdown/core";
import { Crepe } from "@milkdown/crepe";
import type { ListenerManager } from "@milkdown/kit/plugin/listener";
import { isTextOnlySlice } from "@milkdown/prose";
import { DOMParser, DOMSerializer } from "@milkdown/prose/model";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useRef } from "react";
import { TextSelection } from "prosemirror-state";
import { editorViewCtx } from "@milkdown/kit/core";
import { CustomBlockHandle } from "../lib/customBlockHandle";

type MilkdownEditorProps = {
  documentPath: string | null;
  markdown: string;
  onChange: (markdown: string) => void;
  onInsertImage: (file: File) => Promise<string | null>;
};

const markdownClipboardMimeTypes = [
  "text/markdown",
  "text/x-markdown",
  "application/x-markdown",
] as const;

type BlockDragLogEntry = {
  label: string;
  detail: Record<string, unknown>;
  timestamp: string;
};

declare global {
  interface Window {
    __TINYMD_BLOCK_DRAG_LOGS__?: BlockDragLogEntry[];
  }
}

const normalizeStandaloneDisplayMath = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("$$") || !trimmed.endsWith("$$")) {
    return null;
  }

  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return null;
  }

  const body = trimmed.slice(2, -2).trim();
  if (!body || body.includes("$$")) {
    return null;
  }

  return `$$\n${body}\n$$`;
};

const normalizeMarkdownPaste = (text: string) => {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const result: string[] = [];
  let activeFence: "`" | "~" | null = null;

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0] as "`" | "~";
      if (activeFence === null) {
        activeFence = fenceChar;
      } else if (activeFence === fenceChar) {
        activeFence = null;
      }

      result.push(line);
      continue;
    }

    if (!activeFence) {
      const displayMath = normalizeStandaloneDisplayMath(line);
      if (displayMath) {
        result.push(...displayMath.split("\n"));
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
};

const hasMarkdownTable = (lines: string[]) => {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index].trim();
    const separator = lines[index + 1].trim();
    if (!header.includes("|")) {
      continue;
    }

    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(separator)) {
      return true;
    }
  }

  return false;
};

const looksLikeMarkdown = (text: string) => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let score = 0;

  if (lines.some((line) => /^#{1,6}\s+\S/.test(line))) {
    score += 2;
  }

  if (lines.some((line) => /^\s*>/.test(line))) {
    score += 1;
  }

  if (lines.some((line) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line))) {
    score += 1;
  }

  if (lines.some((line) => /^\s*[-*+]\s+\[[ xX]\]\s+\S/.test(line))) {
    score += 2;
  }

  if (lines.some((line) => /^\s*(```|~~~)/.test(line))) {
    score += 2;
  }

  if (lines.some((line) => /^\s*(?:---|\*\*\*|___)\s*$/.test(line))) {
    score += 1;
  }

  if (lines.some((line) => /\[[^\]]+\]\([^)]+\)/.test(line))) {
    score += 1;
  }

  if (
    lines.some(
      (line) =>
        /^\s*\$\$\s*$/.test(line) || /^\s*\$\$[^$\n]+?\$\$\s*$/.test(line)
    )
  ) {
    score += 2;
  }

  if (hasMarkdownTable(lines)) {
    score += 3;
  }

  return score >= 2 && (lines.length > 1 || score >= 3);
};

const getClipboardMarkdown = (clipboardData: DataTransfer) => {
  for (const mimeType of markdownClipboardMimeTypes) {
    const value = clipboardData.getData(mimeType);
    if (value) {
      return {
        text: value,
        source: mimeType,
      };
    }
  }

  return {
    text: clipboardData.getData("text/plain"),
    source: "text/plain",
  };
};

const isImageFile = (file: File) =>
  file.type.startsWith("image/") ||
  /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);

const describeEventTarget = (value: EventTarget | null) => {
  if (!(value instanceof Element)) {
    return String(value);
  }

  const className =
    typeof value.className === "string"
      ? value.className
      : value.getAttribute("class") ?? "";
  return [value.tagName.toLowerCase(), className].filter(Boolean).join(".");
};

const getDataTransferTypes = (event: DragEvent) =>
  event.dataTransfer ? Array.from(event.dataTransfer.types) : [];

const logBlockDrag = (label: string, detail: Record<string, unknown>) => {
  const entry: BlockDragLogEntry = {
    label,
    detail,
    timestamp: new Date().toISOString(),
  };

  const logs = window.__TINYMD_BLOCK_DRAG_LOGS__ ?? [];
  logs.push(entry);
  if (logs.length > 200) {
    logs.splice(0, logs.length - 200);
  }
  window.__TINYMD_BLOCK_DRAG_LOGS__ = logs;
  console.debug("[TinyMD:block-drag]", entry);
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

const resolveMarkdownImagePath = (
  source: string,
  documentPath: string | null,
) => {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (
    /^(?:https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(trimmed) ||
    trimmed.startsWith("//")
  ) {
    return trimmed;
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }

  if (!documentPath) {
    return null;
  }

  return resolveRelativePath(documentPath, trimmed);
};

const lightCodeMirrorTheme = CodeMirrorView.theme(
  {
    "&": {
      backgroundColor: "var(--code)",
      color: "var(--text)",
    },
    ".cm-scroller": {
      fontFamily: "var(--crepe-font-code)",
      lineHeight: "1.55",
    },
    ".cm-content": {
      caretColor: "var(--text)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--code)",
      color: "var(--text-muted)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      fontFamily: "var(--crepe-font-code)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(17, 17, 17, 0.04)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(17, 17, 17, 0.04)",
      color: "var(--text)",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "rgba(17, 17, 17, 0.14)",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--text)",
    },
  },
  { dark: false }
);

export const MilkdownEditor = forwardRef<
  HTMLDivElement,
  MilkdownEditorProps & { docKey: string }
>(function MilkdownEditor({ docKey, documentPath, markdown, onChange, onInsertImage }, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const onInsertImageRef = useRef(onInsertImage);
  const documentPathRef = useRef(documentPath);
  const imageSourceCacheRef = useRef(new Map<string, string>());
  const pendingImageLoadsRef = useRef(new Map<string, Promise<string>>());
  const isComposingRef = useRef(false);
  const lastMarkdownRef = useRef(markdown);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onInsertImageRef.current = onInsertImage;
  }, [onInsertImage]);

  useEffect(() => {
    documentPathRef.current = documentPath;
  }, [documentPath]);

  const emitMarkdown = (value: string) => {
    if (value === lastMarkdownRef.current) {
      return;
    }

    lastMarkdownRef.current = value;
    onChangeRef.current(value);
  };

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }

    rootRef.current.innerHTML = "";

    const editor = new Crepe({
      root: rootRef.current,
      defaultValue: markdown,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          text: "输入 / 唤起更多",
          mode: "block",
        },
        [Crepe.Feature.CodeMirror]: {
          theme: lightCodeMirrorTheme,
        },
      },
    });

    editor.setReadonly(false);
    editor.on((listener: ListenerManager) => {
      listener.markdownUpdated((_ctx: unknown, value: string) => {
        if (isComposingRef.current) {
          return;
        }

        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }

        emitMarkdown(value);
      });

      listener.blur(() => {
        isComposingRef.current = false;
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
        }

        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          emitMarkdown(editor.getMarkdown());
        }, 0);
      });
    });

    let disposed = false;
    let customBlockHandle: CustomBlockHandle | null = null;
    void editor.create().then(() => {
      if (disposed) {
        return;
      }

      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        customBlockHandle = new CustomBlockHandle(ctx);

        const getSelectionSnapshot = () => ({
          type: view.state.selection.constructor.name,
          from: view.state.selection.from,
          to: view.state.selection.to,
          empty: view.state.selection.empty,
        });

        const insertMarkdown = (value: string) => {
          const parser = ctx.get(parserCtx);
          const schema = ctx.get(schemaCtx);
          const doc = parser(value);
          if (!doc || typeof doc === "string") {
            return false;
          }

          const dom = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
          const domParser = DOMParser.fromSchema(schema);
          const slice = domParser.parseSlice(dom);
          const textNode = isTextOnlySlice(slice);

          try {
            const transaction = textNode
              ? view.state.tr.replaceSelectionWith(textNode, true)
              : view.state.tr.replaceSelection(slice);
            view.dispatch(
              transaction
                .scrollIntoView()
                .setMeta("paste", true)
                .setMeta("uiEvent", "paste")
            );
            return true;
          } catch {
            return false;
          }
        };

        const syncImageElements = () => {
          view.dom.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
            const originalSource =
              image.getAttribute("data-markdown-src") ?? image.getAttribute("src") ?? "";
            if (!originalSource) {
              return;
            }

            if (!image.hasAttribute("data-markdown-src")) {
              image.setAttribute("data-markdown-src", originalSource);
            }

            const resolvedSource = resolveMarkdownImagePath(
              originalSource,
              documentPathRef.current,
            );

            if (!resolvedSource) {
              return;
            }

            if (/^(?:https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(resolvedSource)) {
              if (image.getAttribute("src") !== resolvedSource) {
                image.setAttribute("src", resolvedSource);
              }
              return;
            }

            image.setAttribute("data-resolved-path", resolvedSource);

            const cachedSource = imageSourceCacheRef.current.get(resolvedSource);
            if (cachedSource) {
              if (image.getAttribute("src") !== cachedSource) {
                image.setAttribute("src", cachedSource);
              }
              return;
            }

            if (pendingImageLoadsRef.current.has(resolvedSource)) {
              return;
            }

            const loadTask = invoke<string>("read_image_data_url", {
              path: resolvedSource,
            })
              .then((dataUrl) => {
                imageSourceCacheRef.current.set(resolvedSource, dataUrl);
                view.dom
                  .querySelectorAll<HTMLImageElement>(
                    `img[data-resolved-path="${CSS.escape(resolvedSource)}"]`,
                  )
                  .forEach((target) => {
                    target.setAttribute("src", dataUrl);
                  });
                return dataUrl;
              })
              .catch(() => "")
              .finally(() => {
                pendingImageLoadsRef.current.delete(resolvedSource);
              });

            pendingImageLoadsRef.current.set(resolvedSource, loadTask);
          });
        };

        const insertImages = async (files: File[], event?: DragEvent) => {
          const imageFiles = files.filter(isImageFile);
          if (imageFiles.length === 0) {
            return;
          }

          if (event) {
            const position = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            if (position) {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.near(view.state.doc.resolve(position.pos)),
                ),
              );
            }
          }

          const snippets: string[] = [];
          for (const file of imageFiles) {
            const markdownSnippet = await onInsertImageRef.current(file);
            if (markdownSnippet) {
              snippets.push(markdownSnippet);
            }
          }

          if (snippets.length === 0) {
            return;
          }

          if (!insertMarkdown(snippets.join("\n"))) {
            return;
          }

          window.requestAnimationFrame(() => {
            syncImageElements();
          });
        };

        const handleCompositionStart = () => {
          isComposingRef.current = true;
        };

        const handleCompositionEnd = () => {
          isComposingRef.current = false;
          if (flushTimerRef.current !== null) {
            window.clearTimeout(flushTimerRef.current);
          }

          flushTimerRef.current = window.setTimeout(() => {
            flushTimerRef.current = null;
            emitMarkdown(editor.getMarkdown());
          }, 0);
        };
        const handleLinkClick = (event: MouseEvent) => {
          const target = event.target;
          if (!(target instanceof Element)) {
            return;
          }

          const link = target.closest("a[href]");
          const href = link?.getAttribute("href")?.trim();
          if (!href) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          void invoke("open_external_url", { url: href });
        };
        const handlePaste = (event: ClipboardEvent) => {
          if (event.defaultPrevented) {
            return;
          }

          const target = event.target;
          const targetElement =
            target instanceof Element
              ? target
              : target instanceof Node
                ? target.parentElement
                : null;
          if (targetElement?.closest(".cm-editor")) {
            return;
          }

          const clipboardData = event.clipboardData;
          if (!clipboardData) {
            return;
          }

          const imageItem = Array.from(clipboardData.items).find((item) =>
            item.type.startsWith("image/"),
          );
          const imageFile = imageItem?.getAsFile();
          if (imageFile) {
            event.preventDefault();
            event.stopPropagation();
            void insertImages([imageFile]);
            return;
          }

          const { text, source } = getClipboardMarkdown(clipboardData);
          if (!text) {
            return;
          }

          const normalized = normalizeMarkdownPaste(text);
          const hasHtml = clipboardData.getData("text/html").length > 0;
          const shouldPreferMarkdown =
            source !== "text/plain" ||
            normalized !== text ||
            (hasHtml && looksLikeMarkdown(normalized));
          if (!shouldPreferMarkdown) {
            return;
          }

          if (!insertMarkdown(normalized)) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
        };
        const handleDragOver = (event: DragEvent) => {
          const hasImageFile = Array.from(event.dataTransfer?.files ?? []).some(isImageFile);
          if (!hasImageFile) {
            return;
          }

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
        };
        const handleDrop = (event: DragEvent) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
          if (files.length === 0) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          void insertImages(files, event);
        };

        const blockHandleHost = view.dom.parentElement;
        let removeBlockHandleDebug: (() => void) | null = null;
        const cleanupBlockHandleDebug = () => {
          if (!removeBlockHandleDebug) {
            return;
          }

          const cleanup = removeBlockHandleDebug;
          removeBlockHandleDebug = null;
          cleanup();
        };
        const attachBlockHandleDebug = () => {
          const handle =
            blockHandleHost?.querySelector<HTMLDivElement>(".milkdown-block-handle") ?? null;
          if (!handle || handle.dataset.tinymdDebugBound === "true") {
            return;
          }

          handle.dataset.tinymdDebugBound = "true";
          logBlockDrag("handle-attached", {
            draggable: handle.draggable,
            childCount: handle.children.length,
            items: Array.from(handle.children).map((child, index) => ({
              index,
              target: describeEventTarget(child),
            })),
          });

          const handlePointerDown = (event: PointerEvent) => {
            logBlockDrag("handle-pointerdown", {
              button: event.button,
              buttons: event.buttons,
              target: describeEventTarget(event.target),
              currentTarget: describeEventTarget(event.currentTarget),
              show: handle.dataset.show ?? null,
              selection: getSelectionSnapshot(),
            });
          };

          const handleMouseDown = (event: MouseEvent) => {
            logBlockDrag("handle-mousedown", {
              button: event.button,
              buttons: event.buttons,
              target: describeEventTarget(event.target),
              currentTarget: describeEventTarget(event.currentTarget),
              show: handle.dataset.show ?? null,
              selection: getSelectionSnapshot(),
            });
          };

          const handleDragStart = (event: DragEvent) => {
            logBlockDrag("handle-dragstart", {
              target: describeEventTarget(event.target),
              currentTarget: describeEventTarget(event.currentTarget),
              show: handle.dataset.show ?? null,
              draggable: handle.draggable,
              effectAllowed: event.dataTransfer?.effectAllowed ?? null,
              dropEffect: event.dataTransfer?.dropEffect ?? null,
              types: getDataTransferTypes(event),
              selection: getSelectionSnapshot(),
              editorDragging: view.dom.dataset.dragging ?? null,
            });
          };

          const handleDragEnd = (event: DragEvent) => {
            logBlockDrag("handle-dragend", {
              target: describeEventTarget(event.target),
              currentTarget: describeEventTarget(event.currentTarget),
              effectAllowed: event.dataTransfer?.effectAllowed ?? null,
              dropEffect: event.dataTransfer?.dropEffect ?? null,
              types: getDataTransferTypes(event),
              selection: getSelectionSnapshot(),
              editorDragging: view.dom.dataset.dragging ?? null,
            });
          };

          const handleMouseUp = (event: MouseEvent) => {
            logBlockDrag("handle-mouseup", {
              button: event.button,
              buttons: event.buttons,
              target: describeEventTarget(event.target),
              currentTarget: describeEventTarget(event.currentTarget),
              selection: getSelectionSnapshot(),
              editorDragging: view.dom.dataset.dragging ?? null,
            });
          };

          const handleAttrChange = new MutationObserver(() => {
            logBlockDrag("handle-visibility", {
              show: handle.dataset.show ?? null,
              left: handle.style.left || null,
              top: handle.style.top || null,
            });
          });
          handleAttrChange.observe(handle, {
            attributes: true,
            attributeFilter: ["data-show"],
          });

          handle.addEventListener("pointerdown", handlePointerDown, true);
          handle.addEventListener("mousedown", handleMouseDown, true);
          handle.addEventListener("mouseup", handleMouseUp, true);
          handle.addEventListener("dragstart", handleDragStart, true);
          handle.addEventListener("dragend", handleDragEnd, true);

          removeBlockHandleDebug = () => {
            handle.removeEventListener("pointerdown", handlePointerDown, true);
            handle.removeEventListener("mousedown", handleMouseDown, true);
            handle.removeEventListener("mouseup", handleMouseUp, true);
            handle.removeEventListener("dragstart", handleDragStart, true);
            handle.removeEventListener("dragend", handleDragEnd, true);
            handleAttrChange.disconnect();
            delete handle.dataset.tinymdDebugBound;
          };
        };

        const handleDebugObserver = new MutationObserver(() => {
          attachBlockHandleDebug();
        });
        if (blockHandleHost) {
          handleDebugObserver.observe(blockHandleHost, {
            childList: true,
            subtree: true,
          });
          window.requestAnimationFrame(() => {
            attachBlockHandleDebug();
          });
        }

        const handleEditorDragOverDebug = (event: DragEvent) => {
          logBlockDrag("editor-dragover", {
            target: describeEventTarget(event.target),
            currentTarget: describeEventTarget(event.currentTarget),
            effectAllowed: event.dataTransfer?.effectAllowed ?? null,
            dropEffect: event.dataTransfer?.dropEffect ?? null,
            types: getDataTransferTypes(event),
            files: event.dataTransfer?.files.length ?? 0,
            selection: getSelectionSnapshot(),
            editorDragging: view.dom.dataset.dragging ?? null,
          });
        };

        const handleEditorDropDebug = (event: DragEvent) => {
          logBlockDrag("editor-drop", {
            target: describeEventTarget(event.target),
            currentTarget: describeEventTarget(event.currentTarget),
            effectAllowed: event.dataTransfer?.effectAllowed ?? null,
            dropEffect: event.dataTransfer?.dropEffect ?? null,
            types: getDataTransferTypes(event),
            files: event.dataTransfer?.files.length ?? 0,
            selection: getSelectionSnapshot(),
            editorDragging: view.dom.dataset.dragging ?? null,
          });
        };

        view.dom.addEventListener("compositionstart", handleCompositionStart);
        view.dom.addEventListener("compositionend", handleCompositionEnd);
        view.dom.addEventListener("click", handleLinkClick);
        view.dom.addEventListener("paste", handlePaste, true);
        view.dom.addEventListener("dragover", handleDragOver);
        view.dom.addEventListener("drop", handleDrop);
        view.dom.addEventListener("dragover", handleEditorDragOverDebug, true);
        view.dom.addEventListener("drop", handleEditorDropDebug, true);

        const imageObserver = new MutationObserver(() => {
          window.requestAnimationFrame(() => {
            syncImageElements();
          });
        });
        imageObserver.observe(view.dom, {
          childList: true,
          subtree: true,
        });
        syncImageElements();

        if (disposed) {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          view.dom.removeEventListener("dragover", handleDragOver);
          view.dom.removeEventListener("drop", handleDrop);
          view.dom.removeEventListener("dragover", handleEditorDragOverDebug, true);
          view.dom.removeEventListener("drop", handleEditorDropDebug, true);
          customBlockHandle?.destroy();
          customBlockHandle = null;
          cleanupBlockHandleDebug();
          handleDebugObserver.disconnect();
          imageObserver.disconnect();
        }

        const previousDestroy = editor.destroy;
        editor.destroy = () => {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          view.dom.removeEventListener("dragover", handleDragOver);
          view.dom.removeEventListener("drop", handleDrop);
          view.dom.removeEventListener("dragover", handleEditorDragOverDebug, true);
          view.dom.removeEventListener("drop", handleEditorDropDebug, true);
          customBlockHandle?.destroy();
          customBlockHandle = null;
          cleanupBlockHandleDebug();
          handleDebugObserver.disconnect();
          imageObserver.disconnect();
          return previousDestroy();
        };
      });
    });

    editorRef.current = editor;

    return () => {
      disposed = true;
      isComposingRef.current = false;
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const instance = editorRef.current;
      editorRef.current = null;
      if (!instance) {
        return;
      }

      void instance.destroy();
      if (rootRef.current) {
        rootRef.current.innerHTML = "";
      }
    };
  }, [docKey]);

  useEffect(() => {
    lastMarkdownRef.current = markdown;
  }, [markdown]);

  const setRefs = (node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof ref === "function") {
      ref(node);
      return;
    }
    if (ref) {
      ref.current = node;
    }
  };

  return (
    <div className={`editor-shell ${markdown.trim() ? "" : "is-empty"}`.trim()}>
      <div className="editor-host" ref={setRefs} />
    </div>
  );
});
