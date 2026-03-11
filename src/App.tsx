import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./components/FileTree";
import { TabsBar } from "./components/TabsBar";
import { ArticleToc } from "./components/ArticleToc";
import { MilkdownEditor } from "./components/MilkdownEditor";
import { extractToc } from "./lib/toc";
import type { EditorTab, TocItem, TreeNode } from "./types";

type WorkspaceResponse = {
  rootName: string;
  rootPath: string;
  nodes: TreeNode[];
};

const getFileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const TEMP_PREFIX = "temp:";
const UNTITLED_PREFIX = "未命名文档-";

export default function App() {
  const [workspaceName, setWorkspaceName] = useState("未打开工作区");
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("请选择一个 Markdown 文件夹。");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = window.localStorage.getItem("editor-theme");
    return saved === "light" ? "light" : "dark";
  });
  const editorRef = useRef<HTMLDivElement | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  const toc = useMemo(
    () => extractToc(activeTab?.content ?? ""),
    [activeTab?.content],
  );

  const refreshTree = async (path = workspacePath) => {
    if (!path) {
      return;
    }

    const workspace = await invoke<WorkspaceResponse>("load_workspace_tree", {
      rootPath: path,
    });
    setWorkspaceName(workspace.rootName);
    setWorkspacePath(workspace.rootPath);
    setTree(workspace.nodes);
  };

  const isInWorkspace = (path: string) =>
    workspacePath !== null &&
    (path === workspacePath ||
      path.startsWith(`${workspacePath}\\`) ||
      path.startsWith(`${workspacePath}/`));

  const handleOpenWorkspace = async () => {
    const folder = await open({
      directory: true,
      multiple: false,
      title: "选择 Markdown 工作区",
    });

    if (!folder || Array.isArray(folder)) {
      return;
    }

    setBusy(true);
    try {
      const workspace = await invoke<WorkspaceResponse>("load_workspace_tree", {
        rootPath: folder,
      });
      setWorkspaceName(workspace.rootName);
      setWorkspacePath(workspace.rootPath);
      setTree(workspace.nodes);
      setSelectedPath(workspace.rootPath);
      setTabs([]);
      setActiveTabId(null);
      setMessage("工作区已加载，可以从左侧打开文档。");
    } catch (error) {
      setMessage(`打开工作区失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFile = async (path: string) => {
    const existing = tabs.find((tab) => tab.path === path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    setBusy(true);
    try {
      const content = await invoke<string>("read_markdown_file", { path });
      const nextTab: EditorTab = {
        id: path,
        path,
        title: getFileName(path),
        content,
        savedContent: content,
        dirty: false,
        temporary: false,
      };
      setTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      setSelectedPath(path);
      setMessage(`已打开 ${nextTab.title}`);
    } catch (error) {
      setMessage(`打开文件失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTab = async (tab = activeTab) => {
    if (!tab) {
      return;
    }

    setBusy(true);
    try {
      let targetPath = tab.path;
      if (tab.temporary || !targetPath) {
        const suggested = tab.title.endsWith(".md") ? tab.title : `${tab.title}.md`;
        const result = await save({
          title: "保存文档",
          defaultPath: workspacePath ? `${workspacePath}\\${suggested}` : suggested,
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
              }
            : item,
        ),
      );
      setActiveTabId(targetPath);
      setSelectedPath(targetPath);
      setMessage(`已保存 ${getFileName(targetPath)}`);
      if (targetPath && isInWorkspace(targetPath)) {
        await refreshTree();
      }
    } catch (error) {
      setMessage(`保存失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!workspacePath) {
      setMessage("请先打开一个工作区。");
      return;
    }

    const base = selectedPath && !selectedPath.endsWith(".md") ? selectedPath : workspacePath;
    const name = window.prompt("输入文件夹名", "notes");
    if (!name) {
      return;
    }

    setBusy(true);
    try {
      await invoke("create_folder", {
        parentPath: base,
        folderName: name,
      });
      await refreshTree();
      setMessage(`已创建文件夹 ${name}`);
    } catch (error) {
      setMessage(`创建文件夹失败：${String(error)}`);
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
    };

    setTabs((current) => [...current, nextTab]);
    setActiveTabId(id);
    setSelectedPath(null);
    setMessage(`已创建 ${title}，保存时再选择文件名和位置。`);
  };

  const handleJumpToHeading = (item: TocItem) => {
    const headings = editorRef.current?.querySelectorAll(
      "h1, h2, h3, h4, h5, h6",
    );
    const target = headings?.[item.index] as HTMLElement | undefined;
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("editor-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveTab();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="app-shell">
      <aside className="sidebar pane">
        <div className="pane-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{workspaceName}</h1>
          </div>
          <div className="header-actions">
            <button
              className="ghost-button"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "浅色" : "深色"}
            </button>
            <button className="primary-button" onClick={handleOpenWorkspace}>
              打开文件夹
            </button>
          </div>
        </div>

        <div className="action-row">
          <button className="ghost-button" onClick={handleCreateDocument}>
            新建文档
          </button>
          <button className="ghost-button" onClick={handleCreateFolder}>
            新建文件夹
          </button>
        </div>

        <div className="pane-caption">{workspacePath ?? "尚未选择目录"}</div>

        <FileTree
          nodes={tree}
          selectedPath={selectedPath}
          onSelect={(node) => setSelectedPath(node.path)}
          onOpenFile={handleOpenFile}
        />
      </aside>

      <main className="editor-pane pane">
        <div className="pane-header">
          <div>
            <p className="eyebrow">Editor</p>
            <h2>{activeTab?.title ?? "Markdown 编辑区"}</h2>
          </div>
          <div className="header-actions">
            <button
              className="ghost-button"
              onClick={handleCreateDocument}
            >
              新建文档
            </button>
            <button
              className="ghost-button"
              onClick={() => void handleSaveTab()}
              disabled={!activeTab}
            >
              保存
            </button>
          </div>
        </div>

        <TabsBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={handleCloseTab}
        />

        <div className="editor-stage">
          {activeTab ? (
            <MilkdownEditor
              key={activeTab.id}
              docKey={activeTab.id}
              ref={editorRef}
              markdown={activeTab.content}
              onChange={(content) => {
                startTransition(() => {
                  setTabs((current) =>
                    current.map((tab) =>
                      tab.id === activeTab.id
                        ? {
                            ...tab,
                            content,
                            dirty: content !== tab.savedContent,
                          }
                        : tab,
                    ),
                  );
                });
              }}
            />
          ) : (
            <div className="empty-state">
              <h3>左侧选择文档，中央编辑，右侧查看文章目录</h3>
              <p>支持多标签编辑、工作区树、Markdown 实时目录。</p>
            </div>
          )}
        </div>

        <div className="status-bar">
          <span>{message}</span>
          <span>
            {busy
              ? "处理中…"
              : activeTab?.temporary
                ? activeTab.dirty
                  ? "未命名文档 / 未保存"
                  : "未命名文档"
                : activeTab?.dirty
                  ? "未保存"
                  : "已同步"}
          </span>
        </div>
      </main>

      <aside className="toc-pane pane">
        <div className="pane-header">
          <div>
            <p className="eyebrow">Outline</p>
            <h2>文章目录</h2>
          </div>
        </div>

        <ArticleToc items={toc} onJump={handleJumpToHeading} />
      </aside>
    </div>
  );
}
