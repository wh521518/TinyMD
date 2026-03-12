import {
  lazy,
  Suspense,
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { TabsBar } from "./components/TabsBar";
import type { EditorTab } from "./types";

const getFileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
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

const isMarkdownPath = (path: string) => {
  const normalized = normalizeDroppedPath(path);
  return normalized ? /\.(md|markdown)$/i.test(normalized) : false;
};

const getDroppedMarkdownPaths = (paths: string[]) =>
  Array.from(
    new Set(
      paths
        .map(normalizeDroppedPath)
        .filter((path): path is string => Boolean(path))
        .filter((path) => /\.(md|markdown)$/i.test(path)),
    ),
  );
const TEMP_PREFIX = "temp:";
const UNTITLED_PREFIX = "未命名文档-";
const APP_NAME = "TinyMD";
const RECOVERED_PREFIX = "recovered:";

const LazyMilkdownEditor = lazy(async () => {
  const module = await import("./components/MilkdownEditor");
  return { default: module.MilkdownEditor };
});

const copyTextToClipboard = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const successful = document.execCommand("copy");
  textarea.remove();

  if (!successful) {
    throw new Error("系统剪贴板不可用");
  }
};

const getRecoveredTabId = (id: string) =>
  id.startsWith(RECOVERED_PREFIX) ? id : `${RECOVERED_PREFIX}${id}`;

const getRecoveredTabTitle = (title: string) =>
  title.endsWith("（已恢复）") ? title : `${title}（已恢复）`;

type EditorSession = {
  tabs: EditorTab[];
  activeTabId: string | null;
};

type LoadedEditorSession = EditorSession & {
  warnings: string[];
};

type EditorMode = "rich" | "source";

type TabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

export default function App() {
  const dragKindRef = useRef<"valid" | "invalid">("invalid");
  const tabsRef = useRef<EditorTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const loadingTabIdsRef = useRef(new Set<string>());
  const sessionReadyRef = useRef(false);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragState, setDragState] = useState<"idle" | "valid" | "invalid">("idle");
  const [editorMode, setEditorMode] = useState<EditorMode>("rich");
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [message, setMessage] = useState("新建或打开 Markdown 文档开始编辑。");

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const currentWindowTitle = activeTab ? `${activeTab.title} ${APP_NAME}` : APP_NAME;
  const contextMenuTab = useMemo(
    () => tabs.find((tab) => tab.id === tabContextMenu?.tabId) ?? null,
    [tabs, tabContextMenu],
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const openPaths = async (paths: string[], availableTabs = tabsRef.current) => {
    const uniquePaths = Array.from(new Set(paths));
    const existingTabs = new Map(
      availableTabs.filter((tab) => tab.path).map((tab) => [tab.path as string, tab]),
    );
    const pendingPaths = uniquePaths.filter((path) => !existingTabs.has(path));

    if (pendingPaths.length === 0) {
      const lastExisting = uniquePaths[uniquePaths.length - 1];
      if (lastExisting) {
        const targetTab = existingTabs.get(lastExisting);
        setActiveTabId(targetTab?.id ?? lastExisting);
        setMessage(`已切换到 ${targetTab?.title ?? getFileName(lastExisting)}`);
      }
      return;
    }

    setBusy(true);
    try {
      const loadedTabs = await Promise.all(
        pendingPaths.map(async (path) => {
          const content = await invoke<string>("read_markdown_file", { path });
          const nextTab: EditorTab = {
            id: path,
            path,
            title: getFileName(path),
            content,
            savedContent: content,
            dirty: false,
            temporary: false,
            loaded: true,
          };
          return nextTab;
        }),
      );

      setTabs((current) => {
        const existingPaths = new Set(
          current.filter((tab) => tab.path).map((tab) => tab.path as string),
        );
        const tabsToAppend = loadedTabs.filter(
          (tab) => !existingPaths.has(tab.path as string),
        );
        return tabsToAppend.length > 0 ? [...current, ...tabsToAppend] : current;
      });
      setActiveTabId(loadedTabs[loadedTabs.length - 1]?.id ?? activeTabIdRef.current);
      setMessage(
        loadedTabs.length === 1
          ? `已打开 ${loadedTabs[0].title}`
          : `已打开 ${loadedTabs.length} 个文档`,
      );
    } catch (error) {
      setMessage(`打开文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFiles = async () => {
    const result = await open({
      directory: false,
      multiple: true,
      title: "打开 Markdown 文档",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });

    if (!result) {
      return;
    }

    const paths = Array.isArray(result) ? result.map(String) : [String(result)];
    if (paths.length === 0) {
      return;
    }

    await openPaths(paths);
  };

  const handleSaveTab = async (tab = activeTab) => {
    if (!tab) {
      return;
    }

    if (!tab.loaded) {
      setMessage(`正在加载 ${tab.title}，请稍后再保存。`);
      return;
    }

    setBusy(true);
    try {
      let targetPath = tab.path;
      if (tab.temporary || !targetPath) {
        const suggested = tab.title.endsWith(".md") ? tab.title : `${tab.title}.md`;
        const result = await save({
          title: "保存文档",
          defaultPath: suggested,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });

        if (!result || Array.isArray(result)) {
          setMessage("已取消保存。");
          return;
        }

        targetPath = String(result);
      }

      const conflict = tabs.find(
        (item) => item.id !== tab.id && item.path === targetPath,
      );
      if (conflict) {
        setMessage(`保存失败：${getFileName(targetPath)} 已在其他标签中打开。`);
        return;
      }

      await invoke("save_markdown_file", {
        path: targetPath,
        content: tab.content,
      });

      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id
            ? {
                ...item,
                id: targetPath!,
                path: targetPath!,
                title: getFileName(targetPath!),
                savedContent: item.content,
                dirty: false,
                temporary: false,
                loaded: true,
              }
            : item,
        ),
      );
      setActiveTabId(targetPath);
      setMessage(`已保存 ${getFileName(targetPath)}`);
    } catch (error) {
      setMessage(`保存失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCloseTab = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const handleCreateDocument = () => {
    const index = tabs.filter((tab) => tab.temporary).length + 1;
    const title = `${UNTITLED_PREFIX}${index}.md`;
    const id = `${TEMP_PREFIX}${Date.now()}`;
    const nextTab: EditorTab = {
      id,
      path: null,
      title,
      content: "",
      savedContent: "",
      dirty: false,
      temporary: true,
      loaded: true,
    };

    setTabs((current) => [...current, nextTab]);
    setActiveTabId(id);
    setMessage(`已创建 ${title}，保存时再选择文件名和位置。`);
  };

  const handleRichEditorChange = (tabId: string, content: string) => {
    startTransition(() => {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                content,
                dirty: content !== tab.savedContent,
              }
            : tab,
        ),
      );
    });
  };

  const handleSourceEditorChange = (tabId: string, content: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              content,
              dirty: content !== tab.savedContent,
            }
          : tab,
      ),
    );
  };

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.title = currentWindowTitle;
    void getCurrentWindow().setTitle(currentWindowTitle).catch(() => {});
  }, [currentWindowTitle]);

  useEffect(() => {
    if (!activeTab || activeTab.loaded || activeTab.temporary || !activeTab.path) {
      return;
    }

    if (loadingTabIdsRef.current.has(activeTab.id)) {
      return;
    }

    loadingTabIdsRef.current.add(activeTab.id);
    const targetTab = activeTab;

    void invoke<string>("read_markdown_file", { path: targetTab.path })
      .then((content) => {
        setTabs((current) =>
          current.map((tab) =>
            tab.id === targetTab.id
              ? {
                  ...tab,
                  content,
                  savedContent: content,
                  dirty: false,
                  loaded: true,
                }
              : tab,
          ),
        );

        if (activeTabIdRef.current === targetTab.id) {
          setMessage(`已加载 ${targetTab.title}`);
        }
      })
      .catch((error) => {
        let nextActiveId: string | null = activeTabIdRef.current;
        let recovered = false;
        let closed = false;

        setTabs((current) => {
          const target = current.find((tab) => tab.id === targetTab.id);
          if (!target) {
            return current;
          }

          const snapshot = target.content || target.savedContent;
          if (snapshot) {
            const recoveredId = getRecoveredTabId(target.id);
            recovered = true;
            if (activeTabIdRef.current === target.id) {
              nextActiveId = recoveredId;
            }

            return current.map((tab) =>
              tab.id === target.id
                ? {
                    ...tab,
                    id: recoveredId,
                    path: null,
                    title: getRecoveredTabTitle(tab.title),
                    content: snapshot,
                    savedContent: snapshot,
                    dirty: true,
                    temporary: true,
                    loaded: true,
                  }
                : tab,
            );
          }

          closed = true;
          const remainingTabs = current.filter((tab) => tab.id !== target.id);
          if (activeTabIdRef.current === target.id) {
            nextActiveId =
              remainingTabs.length > 0
                ? remainingTabs[remainingTabs.length - 1].id
                : null;
          }
          return remainingTabs;
        });

        if (recovered) {
          if (activeTabIdRef.current === targetTab.id) {
            setActiveTabId(nextActiveId);
          }
          setMessage(`文件已不可用，已将 ${targetTab.title} 恢复为临时文档。`);
          return;
        }

        if (closed && activeTabIdRef.current === targetTab.id) {
          setActiveTabId(nextActiveId);
        }
        setMessage(`加载 ${targetTab.title} 失败：${String(error)}`);
      })
      .finally(() => {
        loadingTabIdsRef.current.delete(targetTab.id);
      });
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      try {
        const [session, launchPaths] = await Promise.all([
          invoke<LoadedEditorSession>("load_editor_session"),
          invoke<string[]>("get_launch_markdown_files").catch(() => []),
        ]);
        if (cancelled) {
          return;
        }

        setTabs(session.tabs);
        setActiveTabId(session.activeTabId);

        if (launchPaths.length > 0) {
          await openPaths(launchPaths, session.tabs);
        } else if (session.warnings.length > 0) {
          setMessage(session.warnings.join(" "));
        } else if (session.tabs.length > 0) {
          setMessage(`已恢复上次打开的 ${session.tabs.length} 个文档。`);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(`恢复编辑状态失败：${String(error)}`);
        }
      } finally {
        sessionReadyRef.current = true;
      }
    };

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionReadyRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      void invoke("save_editor_session", {
        session: {
          tabs,
          activeTabId,
        },
      }).catch((error) => {
        setMessage(`保存编辑状态失败：${String(error)}`);
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [tabs, activeTabId]);

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }

    const closeMenu = () => setTabContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".tab-context-menu")) {
        return;
      }
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [tabContextMenu]);

  const handleDroppedPaths = useEffectEvent((paths: string[]) => {
    const markdownPaths = getDroppedMarkdownPaths(paths);
    if (markdownPaths.length === 0) {
      setMessage("仅支持拖拽打开 Markdown 文档。");
      return;
    }

    void openPaths(markdownPaths);
  });

  const handleOpenTabFolder = async () => {
    if (!contextMenuTab?.path) {
      setMessage("当前标签没有对应的本地文件目录。");
      setTabContextMenu(null);
      return;
    }

    try {
      await invoke("open_file_location", { path: contextMenuTab.path });
      setMessage(`已打开 ${contextMenuTab.title} 所在目录。`);
    } catch (error) {
      setMessage(`打开目录失败：${String(error)}`);
    } finally {
      setTabContextMenu(null);
    }
  };

  const handleCopyContextTabPath = async () => {
    if (!contextMenuTab?.path) {
      setMessage("当前标签没有可复制的本地文件路径。");
      setTabContextMenu(null);
      return;
    }

    try {
      await copyTextToClipboard(contextMenuTab.path);
      setMessage(`已复制 ${contextMenuTab.title} 的文件路径。`);
    } catch (error) {
      setMessage(`复制文件路径失败：${String(error)}`);
    } finally {
      setTabContextMenu(null);
    }
  };

  const handleSaveContextTab = async () => {
    if (!contextMenuTab) {
      return;
    }

    setTabContextMenu(null);
    await handleSaveTab(contextMenuTab);
  };

  const handleCloseContextTab = () => {
    if (!contextMenuTab) {
      return;
    }

    handleCloseTab(contextMenuTab.id);
    setTabContextMenu(null);
  };

  useEffect(() => {
    let mounted = true;

    const setupDragDrop = async () => {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (!mounted) {
          return;
        }

        if (event.payload.type === "enter") {
          dragKindRef.current = event.payload.paths.some(isMarkdownPath)
            ? "valid"
            : "invalid";
          setDragState(dragKindRef.current);
          return;
        }

        if (event.payload.type === "over") {
          setDragState(dragKindRef.current);
          return;
        }

        if (event.payload.type === "leave") {
          setDragState("idle");
          return;
        }

        if (event.payload.type === "drop") {
          setDragState("idle");
          handleDroppedPaths(event.payload.paths);
        }
      });

      if (!mounted) {
        unlisten();
      }

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    void setupDragDrop().then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [handleDroppedPaths]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void handleSaveTab();
        return;
      }

      if (key === "o") {
        event.preventDefault();
        void handleOpenFiles();
        return;
      }

      if (key === "n") {
        event.preventDefault();
        handleCreateDocument();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="app-shell">
      <main className="editor-pane pane">
        <div className="pane-header">
          <div className="header-actions">
            <button
              className="menu-button"
              onClick={() => void handleOpenFiles()}
            >
              打开
            </button>
            <button
              className="menu-button"
              onClick={handleCreateDocument}
            >
              新建
            </button>
            <button
              className="menu-button"
              onClick={() => void handleSaveTab()}
              disabled={!activeTab || !activeTab.loaded}
            >
              保存
            </button>
          </div>
          <div className="toolbar-title">{currentWindowTitle}</div>
        </div>

        <TabsBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={handleCloseTab}
          onContextMenu={(tab, position) =>
            setTabContextMenu({
              tabId: tab.id,
              x: position.x,
              y: position.y,
            })
          }
        />

        <div className="editor-stage">
          {activeTab ? (
            activeTab.loaded ? (
              editorMode === "source" ? (
                <div className="editor-source">
                  <textarea
                    className="editor-source__textarea"
                    value={activeTab.content}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    onChange={(event) =>
                      handleSourceEditorChange(activeTab.id, event.target.value)
                    }
                  />
                </div>
              ) : (
                <Suspense
                  fallback={(
                    <div className="editor-loading">
                      <h3>正在初始化编辑器…</h3>
                    </div>
                  )}
                >
                  <LazyMilkdownEditor
                    key={activeTab.id}
                    docKey={activeTab.id}
                    markdown={activeTab.content}
                    onChange={(content) => {
                      handleRichEditorChange(activeTab.id, content);
                    }}
                  />
                </Suspense>
              )
            ) : (
              <div className="editor-loading">
                <h3>正在载入 {activeTab.title}</h3>
              </div>
            )
          ) : (
            <div className="empty-state">
              <h3>打开文档或新建文档，开始多标签编辑</h3>
              <p>支持多标签新建、打开、拖拽打开和保存。</p>
            </div>
          )}
        </div>

        <div className="status-bar">
          <span className="status-bar__message">{message}</span>
          <div className="status-bar__right">
            <div className="status-toggle" role="group" aria-label="编辑模式">
              <button
                type="button"
                className={`status-toggle__button ${editorMode === "rich" ? "is-active" : ""}`}
                aria-pressed={editorMode === "rich"}
                onClick={() => setEditorMode("rich")}
              >
                MD
              </button>
              <button
                type="button"
                className={`status-toggle__button ${editorMode === "source" ? "is-active" : ""}`}
                aria-pressed={editorMode === "source"}
                onClick={() => setEditorMode("source")}
              >
                原文
              </button>
            </div>
            <span>
            {busy
              ? "处理中…"
              : activeTab && !activeTab.loaded
                ? "载入中"
                : activeTab?.temporary
                ? activeTab.dirty
                  ? "未命名文档 / 未保存"
                  : "未命名文档"
                : activeTab?.dirty
                  ? "未保存"
                  : "已保存"}
            </span>
          </div>
        </div>
      </main>

      {dragState !== "idle" ? (
        <div
          className={`drag-overlay ${dragState === "valid" ? "is-valid" : "is-invalid"}`}
        >
          <div className="drag-overlay__card">
            <strong>
              {dragState === "valid"
                ? "松开以打开 Markdown 文档"
                : "仅支持 .md / .markdown 文件"}
            </strong>
          </div>
        </div>
      ) : null}

      {tabContextMenu ? (
        <div
          className="tab-context-menu"
          style={{
            left: tabContextMenu.x,
            top: tabContextMenu.y,
          }}
        >
          <button
            className="tab-context-menu__item"
            onClick={() => void handleSaveContextTab()}
          >
            保存
          </button>
          <button
            className="tab-context-menu__item"
            onClick={() => void handleOpenTabFolder()}
            disabled={!contextMenuTab?.path}
          >
            打开文件所在目录
          </button>
          <button
            className="tab-context-menu__item"
            onClick={() => void handleCopyContextTabPath()}
            disabled={!contextMenuTab?.path}
          >
            复制文件路径
          </button>
          <button
            className="tab-context-menu__item"
            onClick={handleCloseContextTab}
          >
            关闭
          </button>
        </div>
      ) : null}
    </div>
  );
}
