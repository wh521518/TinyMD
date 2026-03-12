import "@milkdown/crepe/theme/common/style.css";
import { parserCtx, schemaCtx } from "@milkdown/core";
import { Crepe } from "@milkdown/crepe";
import type { ListenerManager } from "@milkdown/kit/plugin/listener";
import { isTextOnlySlice } from "@milkdown/prose";
import { DOMParser, DOMSerializer } from "@milkdown/prose/model";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useRef } from "react";
import { CustomBlockHandle } from "../lib/customBlockHandle";
import { editorViewCtx } from "@milkdown/kit/core";

type MilkdownEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
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
>(function MilkdownEditor({ docKey, markdown, onChange }, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const isComposingRef = useRef(false);
  const lastMarkdownRef = useRef(markdown);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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

        view.dom.addEventListener("compositionstart", handleCompositionStart);
        view.dom.addEventListener("compositionend", handleCompositionEnd);
        view.dom.addEventListener("click", handleLinkClick);
        view.dom.addEventListener("paste", handlePaste, true);

        if (disposed) {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          customBlockHandle.destroy();
          customBlockHandle = null;
        }

        const previousDestroy = editor.destroy;
        editor.destroy = () => {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          view.dom.removeEventListener("click", handleLinkClick);
          view.dom.removeEventListener("paste", handlePaste, true);
          customBlockHandle?.destroy();
          customBlockHandle = null;
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
    <div className="editor-shell">
      <div className="editor-host" ref={setRefs} />
    </div>
  );
});
