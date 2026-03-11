import { editorViewCtx } from "@milkdown/kit/core";
import { Crepe } from "@milkdown/crepe";
import type { ListenerManager } from "@milkdown/kit/plugin/listener";
import { forwardRef, useEffect, useRef } from "react";
import { CustomBlockHandle } from "../lib/customBlockHandle";

type MilkdownEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
};

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

        view.dom.addEventListener("compositionstart", handleCompositionStart);
        view.dom.addEventListener("compositionend", handleCompositionEnd);

        if (disposed) {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          customBlockHandle.destroy();
          customBlockHandle = null;
        }

        const previousDestroy = editor.destroy;
        editor.destroy = () => {
          view.dom.removeEventListener("compositionstart", handleCompositionStart);
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
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
