import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/prose/gapcursor/style/gapcursor.css";
import "./milkdownMenuOverrides.css";
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
import {
  logTaskListDebug,
  normalizeTaskListMarkdown,
} from "../lib/normalizeTaskListMarkdown";
import {
  attachmentBlockComponent,
  attachmentBlockConfig,
} from "../lib/milkdownAttachmentBlock";

type MilkdownEditorProps = {
  documentPath: string | null;
  markdown: string;
  onChange: (markdown: string) => void;
  attachmentRevealLabel: string;
  attachmentImportingLabel: string;
  attachmentImportFailedLabel: string;
  onOpenLocalPath: (path: string, label?: string) => Promise<void>;
  onRevealLocalPath: (path: string, label?: string) => Promise<void>;
  resolveDroppedSourcePaths: (
    files: File[],
    dataTransfer: DataTransfer | null,
  ) => Array<string | null>;
  resolveDroppedPaths: (dataTransfer: DataTransfer | null) => string[];
  onInsertAsset: (
    file: File,
    sourcePath: string | null | undefined,
    origin: "drop" | "paste",
  ) => Promise<string | null>;
  onInsertAssetPath: (
    sourcePath: string,
    origin: "drop",
  ) => Promise<string | null>;
};

type InsertMarkdownOptions = {
  preferTextCursorAfterAttachment?: boolean;
};

const markdownClipboardMimeTypes = [
  "text/markdown",
  "text/x-markdown",
  "application/x-markdown",
] as const;

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

  return normalizeTaskListMarkdown(result.join("\n"));
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

const isMarkdownFile = (file: File) => /\.(md|markdown)$/i.test(file.name);

const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path.trim());
const INSERT_DROPPED_ASSET_PATHS_EVENT = "insert-dropped-asset-paths";

type DroppedFileWithPath = File & {
  path?: string;
};

const normalizeDroppedPath = (value: string) => {
  const trimmed = value.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) {
    return null;
  }

  let normalized = trimmed;

  if (/^file:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      normalized = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:/.test(normalized)) {
        normalized = normalized.slice(1);
      }
    } catch {
      normalized = normalized.replace(/^file:\/+/i, "");
    }
  } else {
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep the original string if the drag source provided a plain file path.
    }
  }

  normalized = normalized.replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  return normalized || null;
};

const getDroppedFilePaths = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) {
    return [];
  }

  const directPaths = Array.from(dataTransfer.files)
    .map((file) => normalizeDroppedPath((file as DroppedFileWithPath).path ?? ""))
    .filter((path): path is string => Boolean(path));

  if (directPaths.length > 0) {
    return directPaths;
  }

  const uriList = dataTransfer.getData("text/uri-list");
  if (!uriList) {
    return [];
  }

  return uriList
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#"))
    .map(normalizeDroppedPath)
    .filter((path): path is string => Boolean(path));
};

const hasExternalFileTransfer = (dataTransfer: DataTransfer | null) =>
  Array.from(dataTransfer?.types ?? []).includes("Files");

const getAttachableFiles = (files: Iterable<File>) =>
  Array.from(files).filter((file) => !isMarkdownFile(file));

const joinAssetBlocks = (snippets: string[]) => snippets.join("\n\n");

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

const isMacWebKit = () => {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: {
        platform?: string;
      };
    }
  ).userAgentData;
  const platform =
    typeof userAgentData?.platform === "string" ? userAgentData.platform : navigator.platform;
  return /mac/i.test(platform);
};

export const MilkdownEditor = forwardRef<
  HTMLDivElement,
  MilkdownEditorProps & { docKey: string }
>(function MilkdownEditor(
  {
    docKey,
    documentPath,
    markdown,
    onChange,
    attachmentRevealLabel,
    attachmentImportingLabel,
    attachmentImportFailedLabel,
    onOpenLocalPath,
    onRevealLocalPath,
    resolveDroppedSourcePaths,
    resolveDroppedPaths,
    onInsertAsset,
    onInsertAssetPath,
  },
  ref,
) {
  const usesMacCustomListView = isMacWebKit();
  const normalizedInitialMarkdown = normalizeTaskListMarkdown(markdown);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const attachmentRevealLabelRef = useRef(attachmentRevealLabel);
  const attachmentImportingLabelRef = useRef(attachmentImportingLabel);
  const attachmentImportFailedLabelRef = useRef(attachmentImportFailedLabel);
  const onOpenLocalPathRef = useRef(onOpenLocalPath);
  const onRevealLocalPathRef = useRef(onRevealLocalPath);
  const resolveDroppedSourcePathsRef = useRef(resolveDroppedSourcePaths);
  const resolveDroppedPathsRef = useRef(resolveDroppedPaths);
  const onInsertAssetRef = useRef(onInsertAsset);
  const onInsertAssetPathRef = useRef(onInsertAssetPath);
  const documentPathRef = useRef(documentPath);
  const imageSourceCacheRef = useRef(new Map<string, string>());
  const pendingImageLoadsRef = useRef(new Map<string, Promise<string>>());
  const isComposingRef = useRef(false);
  const lastMarkdownRef = useRef(normalizedInitialMarkdown);
  const flushTimerRef = useRef<number | null>(null);
  const isEditorReadyRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    attachmentRevealLabelRef.current = attachmentRevealLabel;
  }, [attachmentRevealLabel]);

  useEffect(() => {
    attachmentImportingLabelRef.current = attachmentImportingLabel;
  }, [attachmentImportingLabel]);

  useEffect(() => {
    attachmentImportFailedLabelRef.current = attachmentImportFailedLabel;
  }, [attachmentImportFailedLabel]);

  useEffect(() => {
    onOpenLocalPathRef.current = onOpenLocalPath;
  }, [onOpenLocalPath]);

  useEffect(() => {
    onRevealLocalPathRef.current = onRevealLocalPath;
  }, [onRevealLocalPath]);

  useEffect(() => {
    resolveDroppedSourcePathsRef.current = resolveDroppedSourcePaths;
  }, [resolveDroppedSourcePaths]);

  useEffect(() => {
    resolveDroppedPathsRef.current = resolveDroppedPaths;
  }, [resolveDroppedPaths]);

  useEffect(() => {
    onInsertAssetRef.current = onInsertAsset;
  }, [onInsertAsset]);

  useEffect(() => {
    onInsertAssetPathRef.current = onInsertAssetPath;
  }, [onInsertAssetPath]);

  useEffect(() => {
    documentPathRef.current = documentPath;
  }, [documentPath]);

  const emitMarkdown = (value: string) => {
    const normalizedValue = normalizeTaskListMarkdown(value);
    logTaskListDebug("milkdown:emit", value, normalizedValue, {
      documentPath: documentPathRef.current,
    });
    if (normalizedValue === lastMarkdownRef.current) {
      return;
    }

    lastMarkdownRef.current = normalizedValue;
    onChangeRef.current(normalizedValue);
  };

  const flushMarkdownFromEditor = (editor: Crepe) => {
    if (!isEditorReadyRef.current || editorRef.current !== editor) {
      return;
    }

    try {
      emitMarkdown(editor.getMarkdown());
    } catch {
      // Ignore stale blur/composition callbacks during editor teardown/recreate.
    }
  };

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }

    isEditorReadyRef.current = false;
    rootRef.current.innerHTML = "";
    // macOS Tauri runs on WKWebView/WebKit. We keep Windows and other platforms
    // on the stock Crepe list-item path, while macOS uses a custom list gutter
    // so list markers do not depend on native WebKit rendering.
    const disableListItemFeature = usesMacCustomListView;
    if (import.meta.env.DEV) {
      console.info("[tinymd:list-debug] editor-init", {
        usesMacCustomListView,
        userAgent:
          typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      });
    }

    const editor = new Crepe({
      root: rootRef.current,
      defaultValue: normalizedInitialMarkdown,
      features: disableListItemFeature
        ? {
            [Crepe.Feature.ListItem]: false,
          }
        : undefined,
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

    editor.editor
      .use(attachmentBlockComponent)
      .config((ctx) => {
        ctx.update(attachmentBlockConfig.key, (value) => ({
          ...value,
          getDocumentPath: () => documentPathRef.current,
          getRevealLocalPathLabel: () => attachmentRevealLabelRef.current,
          getImportingLabel: () => attachmentImportingLabelRef.current,
          getImportFailedLabel: () => attachmentImportFailedLabelRef.current,
          openLocalPath: (path: string, label?: string) =>
            onOpenLocalPathRef.current(path, label),
          revealLocalPath: (path: string, label?: string) =>
            onRevealLocalPathRef.current(path, label),
        }));
      });

    editor.setReadonly(false);
    editor.on((listener: ListenerManager) => {
      listener.markdownUpdated((_ctx: unknown, value: string) => {
        if (isComposingRef.current) {
          return;
        }

        logTaskListDebug("milkdown:markdownUpdated", value, normalizeTaskListMarkdown(value), {
          documentPath: documentPathRef.current,
        });

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
          flushMarkdownFromEditor(editor);
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
        isEditorReadyRef.current = true;
        customBlockHandle = new CustomBlockHandle(ctx);

        let decorationSyncFrame = 0;
        let syncMacListMetadata = () => {};
        const scheduleDecorationSync = () => {
          if (decorationSyncFrame) {
            window.cancelAnimationFrame(decorationSyncFrame);
          }

          decorationSyncFrame = window.requestAnimationFrame(() => {
            decorationSyncFrame = 0;
            syncImageElements();
            syncMacListMetadata();

            // ProseMirror may patch the DOM again on the next frame after insertion.
            window.requestAnimationFrame(() => {
              syncImageElements();
              syncMacListMetadata();
            });
          });
        };

        const insertTextCursorAfterAttachment = (transaction: typeof view.state.tr) => {
          const { selection } = transaction;
          const $from = selection.$from;
          const nodeBefore = $from.nodeBefore;
          const nodeAfter = $from.nodeAfter;
          const hasAttachmentNeighbor =
            nodeBefore?.type.name === "attachment" || nodeAfter?.type.name === "attachment";

          if ($from.parent.inlineContent || !hasAttachmentNeighbor) {
            return transaction;
          }

          const defaultType = $from.parent.contentMatchAt($from.index()).defaultType;
          if (!defaultType || !defaultType.isTextblock) {
            return transaction;
          }

          const paragraph = defaultType.createAndFill();
          if (!paragraph) {
            return transaction;
          }

          const insertPos = $from.pos;
          transaction.insert(insertPos, paragraph);
          transaction.setSelection(TextSelection.near(transaction.doc.resolve(insertPos + 1)));
          return transaction;
        };

        const insertMarkdown = (value: string, options?: InsertMarkdownOptions) => {
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
            let transaction =
              textNode
                ? view.state.tr.replaceSelectionWith(textNode, true)
                : view.state.tr.replaceSelection(slice);

            if (options?.preferTextCursorAfterAttachment && !textNode) {
              transaction = insertTextCursorAfterAttachment(transaction);
            }

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

        const insertAssets = async (files: File[], event?: DragEvent) => {
          const fileList = Array.from(files);
          const origin: "drop" | "paste" = event ? "drop" : "paste";
          const sourcePaths = resolveDroppedSourcePathsRef.current(
            fileList,
            event?.dataTransfer ?? null,
          );
          const attachableEntries = fileList
            .map((file, index) => ({
              file,
              sourcePath:
                sourcePaths[index] ??
                normalizeDroppedPath((file as DroppedFileWithPath).path ?? ""),
            }))
            .filter((entry) => !isMarkdownFile(entry.file));
          const attachableFiles = attachableEntries.map((entry) => entry.file);
          if (attachableFiles.length === 0) {
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
          for (const entry of attachableEntries) {
            const markdownSnippet = await onInsertAssetRef.current(
              entry.file,
              entry.sourcePath,
              origin,
            );
            if (markdownSnippet) {
              snippets.push(markdownSnippet);
            }
          }

          if (snippets.length === 0) {
            return;
          }

          if (!insertMarkdown(joinAssetBlocks(snippets), { preferTextCursorAfterAttachment: true })) {
            return;
          }

          scheduleDecorationSync();
        };

        const insertAssetsFromPaths = async (
          paths: string[],
          dropPosition?: { x: number; y: number } | null,
        ) => {
          const attachablePaths = Array.from(
            new Set(paths.map(normalizeDroppedPath).filter((path): path is string => Boolean(path))),
          ).filter((path) => !isMarkdownPath(path));
          if (attachablePaths.length === 0) {
            return;
          }

          if (dropPosition) {
            const scale = window.devicePixelRatio || 1;
            const position = view.posAtCoords({
              left: dropPosition.x / scale,
              top: dropPosition.y / scale,
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
          for (const sourcePath of attachablePaths) {
            const markdownSnippet = await onInsertAssetPathRef.current(sourcePath, "drop");
            if (markdownSnippet) {
              snippets.push(markdownSnippet);
            }
          }

          if (snippets.length === 0) {
            return;
          }

          if (!insertMarkdown(joinAssetBlocks(snippets), { preferTextCursorAfterAttachment: true })) {
            return;
          }

          scheduleDecorationSync();
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
            flushMarkdownFromEditor(editor);
          }, 0);
        };
        const macListGutterPx = 44;
        const getListItemContextAtPos = (pos: number) => {
          try {
            const $pos = view.state.doc.resolve(pos);

            for (let depth = $pos.depth; depth > 0; depth -= 1) {
              const node = $pos.node(depth);
              if (node.type.name !== "list_item") {
                continue;
              }

              return {
                item: node,
                itemPos: $pos.before(depth),
              };
            }
          } catch {
            return null;
          }

          return null;
        };
        const getListItemContextFromElement = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const probePosition = view.posAtCoords({
            left: rect.left + Math.min(12, Math.max(rect.width - 1, 1)),
            top: rect.top + Math.min(rect.height / 2, 16),
          });

          if (typeof probePosition?.inside !== "number") {
            return null;
          }

          return getListItemContextAtPos(probePosition.inside);
        };
        syncMacListMetadata = () => {
          if (!usesMacCustomListView) {
            return;
          }

          view.dom.querySelectorAll<HTMLLIElement>("li").forEach((listItem) => {
            const context = getListItemContextFromElement(listItem);
            if (!context) {
              delete listItem.dataset.itemType;
              delete listItem.dataset.checked;
              return;
            }

            if (context.item.attrs.checked == null) {
              delete listItem.dataset.itemType;
              delete listItem.dataset.checked;
              return;
            }

            listItem.dataset.itemType = "task";
            listItem.dataset.checked = String(Boolean(context.item.attrs.checked));
          });
        };
        const getTaskListItemFromPoint = (x: number, y: number) => {
          const candidates = Array.from(
            view.dom.querySelectorAll<HTMLElement>('li[data-item-type="task"]'),
          );

          for (const listItem of candidates) {
            const rect = listItem.getBoundingClientRect();
            const markerHitMin = rect.left - macListGutterPx;
            const markerHitMax = rect.left + 6;
            const isWithinRow = y >= rect.top && y <= rect.bottom;
            const isWithinMarker = x >= markerHitMin && x <= markerHitMax;

            if (isWithinRow && isWithinMarker) {
              return listItem;
            }
          }

          return null;
        };
        const handleMacTaskListPointerDown = (event: PointerEvent) => {
          if (!usesMacCustomListView) {
            return;
          }

          const target = event.target;
          if (!(target instanceof Element)) {
            return;
          }

          if (!view.dom.contains(target)) {
            return;
          }

          const listItem = getTaskListItemFromPoint(event.clientX, event.clientY);
          if (!listItem) {
            return;
          }

          const context = getListItemContextFromElement(listItem);
          if (!context || context.item.attrs.checked == null) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          view.dispatch(
            view.state.tr.setNodeAttribute(
              context.itemPos,
              "checked",
              !Boolean(context.item.attrs.checked),
            ),
          );

          if (!view.hasFocus()) {
            view.focus();
          }
        };
        let orderedListCleanupTimer: number | null = null;
        const getOrderedListContext = (currentView: typeof view) => {
          const { $from } = currentView.state.selection;

          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.name !== "list_item") {
              continue;
            }

            if (depth < 1) {
              return null;
            }

            const parent = $from.node(depth - 1);
            if (parent.type.name !== "ordered_list") {
              return null;
            }

            return {
              index: $from.index(depth - 1),
              item: node,
              itemPos: $from.before(depth),
            };
          }

          return null;
        };
        const cleanupMacOrderedListAutoLabel = (currentView: typeof view) => {
          if (!usesMacCustomListView) {
            return;
          }

          const context = getOrderedListContext(currentView);
          if (!context) {
            return;
          }

          const { item, itemPos, index } = context;
          const firstChild = item.firstChild;
          if (!firstChild?.isTextblock) {
            return;
          }

          const unwantedLabel = `${index + 2}.`;
          const itemText = item.textContent.trim();
          const firstChildText = firstChild.textContent.trim();
          if (itemText !== unwantedLabel || firstChildText !== unwantedLabel) {
            return;
          }

          const paragraphPos = itemPos + 1;
          const textFrom = paragraphPos + 1;
          const textTo = paragraphPos + firstChild.content.size + 1;
          if (textTo <= textFrom) {
            return;
          }

          currentView.dispatch(currentView.state.tr.delete(textFrom, textTo));
        };
        const scheduleMacOrderedListCleanup = (currentView: typeof view) => {
          if (!usesMacCustomListView) {
            return;
          }

          if (orderedListCleanupTimer !== null) {
            window.clearTimeout(orderedListCleanupTimer);
          }

          orderedListCleanupTimer = window.setTimeout(() => {
            orderedListCleanupTimer = null;
            cleanupMacOrderedListAutoLabel(currentView);
            window.requestAnimationFrame(() => {
              cleanupMacOrderedListAutoLabel(currentView);
            });
          }, 0);
        };
        const previousHandleKeyDown = view.props.handleKeyDown;
        const handleEditorKeyDown = (currentView: typeof view, event: KeyboardEvent) => {
          const orderedListContext =
            event.key === "Enter" ? getOrderedListContext(currentView) : null;
          // Route IME confirmation Enter through ProseMirror's keydown pipeline.
          // Returning true here lets ProseMirror prevent default and avoids
          // duplicate Enter handling from mixed DOM/PM event paths.
          const isImeConfirmEnter =
            event.key === "Enter" &&
            (event.isComposing || isComposingRef.current || event.keyCode === 229);
          if (isImeConfirmEnter) {
            if (orderedListContext) {
              scheduleMacOrderedListCleanup(currentView);
            }
            return true;
          }

          if (orderedListContext) {
            scheduleMacOrderedListCleanup(currentView);
          }

          return previousHandleKeyDown ? previousHandleKeyDown(currentView, event) : false;
        };
        view.setProps({
          handleKeyDown: handleEditorKeyDown,
        });
        const handleLinkClick = (event: MouseEvent) => {
          const target = event.target;
          if (!(target instanceof Element)) {
            return;
          }

          const link = target.closest("a[href]");
          const href = link?.getAttribute("href")?.trim();
          if (!href || href.startsWith("#")) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          if (/^(?:https?:|mailto:)/i.test(href)) {
            void invoke("open_external_url", { url: href });
            return;
          }

          const resolvedPath = resolveMarkdownImagePath(href, documentPathRef.current);
          if (!resolvedPath) {
            return;
          }

          void onOpenLocalPathRef.current(resolvedPath, link?.textContent?.trim());
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

          const files = getAttachableFiles(
            Array.from(clipboardData.items)
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file)),
          );
          if (files.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            void insertAssets(files);
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
          if (!hasExternalFileTransfer(event.dataTransfer ?? null)) {
            return;
          }

          const files = getAttachableFiles(event.dataTransfer?.files ?? []);
          const attachablePaths = resolveDroppedPathsRef
            .current(event.dataTransfer ?? null)
            .filter((path) => !isMarkdownPath(path));
          if (files.length === 0 && attachablePaths.length === 0) {
            return;
          }

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
        };
        const handleDrop = (event: DragEvent) => {
          if (!hasExternalFileTransfer(event.dataTransfer ?? null)) {
            return;
          }

          const files = getAttachableFiles(event.dataTransfer?.files ?? []);
          const attachablePaths = resolveDroppedPathsRef
            .current(event.dataTransfer ?? null)
            .filter((path) => !isMarkdownPath(path));
          if (files.length === 0 && attachablePaths.length === 0) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
        };

        const handleInsertAssetPaths = (event: Event) => {
          const customEvent = event as CustomEvent<{
            paths?: string[];
            position?: { x: number; y: number };
          }>;
          const paths = Array.isArray(customEvent.detail?.paths)
            ? customEvent.detail.paths.filter((path): path is string => typeof path === "string")
            : [];
          if (paths.length === 0) {
            return;
          }

          void insertAssetsFromPaths(paths, customEvent.detail?.position ?? null);
        };

        view.dom.addEventListener("compositionstart", handleCompositionStart);
        view.dom.addEventListener("compositionend", handleCompositionEnd);
        view.dom.addEventListener("pointerdown", handleMacTaskListPointerDown, true);
        view.dom.addEventListener("click", handleLinkClick);
        view.dom.addEventListener("paste", handlePaste, true);
        view.dom.addEventListener("dragover", handleDragOver);
        view.dom.addEventListener("drop", handleDrop);
        rootRef.current?.addEventListener(INSERT_DROPPED_ASSET_PATHS_EVENT, handleInsertAssetPaths);

        const imageObserver = new MutationObserver(() => {
          scheduleDecorationSync();
        });
        imageObserver.observe(view.dom, {
          childList: true,
          subtree: true,
        });
        scheduleDecorationSync();

        if (disposed) {
          if (decorationSyncFrame) {
            window.cancelAnimationFrame(decorationSyncFrame);
            decorationSyncFrame = 0;
          }
          if (orderedListCleanupTimer !== null) {
            window.clearTimeout(orderedListCleanupTimer);
            orderedListCleanupTimer = null;
          }
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("pointerdown", handleMacTaskListPointerDown, true);
          view.setProps({
            handleKeyDown: previousHandleKeyDown,
          });
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          view.dom.removeEventListener("dragover", handleDragOver);
          view.dom.removeEventListener("drop", handleDrop);
          rootRef.current?.removeEventListener(INSERT_DROPPED_ASSET_PATHS_EVENT, handleInsertAssetPaths);
          customBlockHandle?.destroy();
          customBlockHandle = null;
          imageObserver.disconnect();
        }

        const previousDestroy = editor.destroy;
        editor.destroy = () => {
          if (decorationSyncFrame) {
            window.cancelAnimationFrame(decorationSyncFrame);
            decorationSyncFrame = 0;
          }
          if (orderedListCleanupTimer !== null) {
            window.clearTimeout(orderedListCleanupTimer);
            orderedListCleanupTimer = null;
          }
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("pointerdown", handleMacTaskListPointerDown, true);
          view.setProps({
            handleKeyDown: previousHandleKeyDown,
          });
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          view.dom.removeEventListener("dragover", handleDragOver);
          view.dom.removeEventListener("drop", handleDrop);
          rootRef.current?.removeEventListener(INSERT_DROPPED_ASSET_PATHS_EVENT, handleInsertAssetPaths);
          customBlockHandle?.destroy();
          customBlockHandle = null;
          imageObserver.disconnect();
          return previousDestroy();
        };
      });
    });

    editorRef.current = editor;

    return () => {
      disposed = true;
      isComposingRef.current = false;
      isEditorReadyRef.current = false;
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
    lastMarkdownRef.current = normalizeTaskListMarkdown(markdown);
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
    <div
      className={[
        "editor-shell",
        markdown.trim() ? "" : "is-empty",
        usesMacCustomListView ? "uses-mac-custom-list-view" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="editor-host" ref={setRefs} />
    </div>
  );
});
