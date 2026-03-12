import {
  lazy,
  Suspense,
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { message as showDialogMessage, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

const isMarkdownFile = (file: File) => /\.(md|markdown)$/i.test(file.name);

type DroppedFileWithPath = File & {
  path?: string;
};

const getDroppedPathsFromDataTransfer = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) {
    return [];
  }

  const directPaths = Array.from(dataTransfer.files)
    .map((file) => (file as DroppedFileWithPath).path ?? null)
    .map((path) => (path ? normalizeDroppedPath(path) : null))
    .filter((path): path is string => Boolean(path));

  if (directPaths.length > 0) {
    return Array.from(new Set(directPaths));
  }

  const uriList = dataTransfer.getData("text/uri-list");
  if (!uriList) {
    return [];
  }

  return Array.from(
    new Set(
      uriList
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("#"))
        .map(normalizeDroppedPath)
        .filter((path): path is string => Boolean(path)),
    ),
  );
};

const canUseLocalFilePath = (
  tab: EditorTab | null | undefined,
): tab is EditorTab & { path: string } => Boolean(tab?.path && !tab.temporary);

const TEMP_PREFIX = "temp:";
const APP_NAME = "TinyMD";
const RECOVERED_PREFIX = "recovered:";
const LANGUAGE_STORAGE_KEY = "tinymd.language";
const IMAGE_FOLDER_STORAGE_KEY = "tinymd.imageFolder";
const DEFAULT_IMAGE_FOLDER = "assets";

type AppDragLogEntry = {
  label: string;
  detail: Record<string, unknown>;
  timestamp: string;
};

declare global {
  interface Window {
    __TINYMD_APP_DRAG_LOGS__?: AppDragLogEntry[];
  }
}

const describeDragTarget = (value: EventTarget | null) => {
  if (!(value instanceof Element)) {
    return String(value);
  }

  const className =
    typeof value.className === "string"
      ? value.className
      : value.getAttribute("class") ?? "";
  return [value.tagName.toLowerCase(), className].filter(Boolean).join(".");
};

const logAppDrag = (label: string, detail: Record<string, unknown>) => {
  const entry: AppDragLogEntry = {
    label,
    detail,
    timestamp: new Date().toISOString(),
  };

  const logs = window.__TINYMD_APP_DRAG_LOGS__ ?? [];
  logs.push(entry);
  if (logs.length > 200) {
    logs.splice(0, logs.length - 200);
  }
  window.__TINYMD_APP_DRAG_LOGS__ = logs;
  console.debug("[TinyMD:app-drag]", entry);
};

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
    throw new Error("Clipboard unavailable");
  }
};

const getRecoveredTabId = (id: string) =>
  id.startsWith(RECOVERED_PREFIX) ? id : `${RECOVERED_PREFIX}${id}`;

const getRecoveredTabTitle = (title: string, suffix: string) =>
  title.endsWith(suffix) ? title : `${title}${suffix}`;

type EditorSession = {
  tabs: EditorTab[];
  activeTabId: string | null;
};

type LoadedEditorSession = EditorSession & {
  warnings: string[];
};

type EditorMode = "rich" | "source";
type UiLanguage = "zh-CN" | "en-US";

type OutlineItem = {
  id: string;
  level: number;
  title: string;
  line: number;
};

type TabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

type UiText = {
  menuOpen: string;
  menuNew: string;
  menuSave: string;
  menuImages: string;
  menuLanguage: string;
  languageChinese: string;
  languageEnglish: string;
  languageChanged: string;
  openDialogTitle: string;
  saveDialogTitle: string;
  readyMessage: string;
  switchedTo: (title: string) => string;
  openedFile: (title: string) => string;
  openedFiles: (count: number) => string;
  openFailed: (error: string) => string;
  loadingBeforeSave: (title: string) => string;
  saveCanceled: string;
  saveConflict: (title: string) => string;
  saveSuccess: (title: string) => string;
  saveFailed: (error: string) => string;
  untitledPrefix: string;
  createdDocument: (title: string) => string;
  editModeLabel: string;
  viewLabel: string;
  modeSource: string;
  outlineLabel: string;
  working: string;
  loading: string;
  untitledUnsaved: string;
  untitled: string;
  unsaved: string;
  saved: string;
  editorInitializing: string;
  loadingTab: (title: string) => string;
  emptyTitle: string;
  emptyDescription: string;
  outlineHeader: string;
  outlineEmpty: string;
  outlinePrompt: string;
  dropToOpen: string;
  dropUnsupportedOverlay: string;
  dropUnsupportedMessage: string;
  noLocalDirectory: string;
  openedFolder: (title: string) => string;
  openFolderFailed: (error: string) => string;
  noCopyPath: string;
  copiedFilePath: (title: string) => string;
  copyFailed: (error: string) => string;
  contextSave: string;
  contextOpenFolder: string;
  contextCopyPath: string;
  contextClose: string;
  loadedTab: (title: string) => string;
  recoveredSuffix: string;
  fileRecovered: (title: string) => string;
  loadFailed: (title: string, error: string) => string;
  restoredSession: (count: number) => string;
  restoreFailed: (error: string) => string;
  saveSessionFailed: (error: string) => string;
  imageFolderPrompt: (folder: string) => string;
  imageFolderUpdated: (folder: string) => string;
  imageFolderInvalid: string;
  imageRequiresSavedDocument: string;
  imageInsertFailed: (error: string) => string;
  imageInserted: (name: string) => string;
  confirmCloseDirtyTab: (title: string) => string;
  confirmCloseDirtyWindow: (count: number) => string;
  unsavedSave: string;
  unsavedDiscard: string;
  unsavedCancel: string;
};

const UI_TEXT: Record<UiLanguage, UiText> = {
  "zh-CN": {
    menuOpen: "打开(O)",
    menuNew: "新建(N)",
    menuSave: "保存(S)",
    menuImages: "图片(I)",
    menuLanguage: "语言(L)",
    languageChinese: "简体中文",
    languageEnglish: "English",
    languageChanged: "界面语言已切换为简体中文。",
    openDialogTitle: "打开 Markdown 文档",
    saveDialogTitle: "保存文档",
    readyMessage: "新建或打开 Markdown 文档开始编辑。",
    switchedTo: (title) => `已切换到 ${title}`,
    openedFile: (title) => `已打开 ${title}`,
    openedFiles: (count) => `已打开 ${count} 个文档`,
    openFailed: (error) => `打开文档失败：${error}`,
    loadingBeforeSave: (title) => `正在加载 ${title}，请稍后再保存。`,
    saveCanceled: "已取消保存。",
    saveConflict: (title) => `保存失败：${title} 已在其他标签中打开。`,
    saveSuccess: (title) => `已保存 ${title}`,
    saveFailed: (error) => `保存失败：${error}`,
    untitledPrefix: "未命名文档-",
    createdDocument: (title) => `已创建 ${title}，保存时再选择文件名和位置。`,
    editModeLabel: "编辑模式",
    viewLabel: "视图",
    modeSource: "原文",
    outlineLabel: "目录",
    working: "处理中…",
    loading: "载入中",
    untitledUnsaved: "未命名文档 / 未保存",
    untitled: "未命名文档",
    unsaved: "未保存",
    saved: "已保存",
    editorInitializing: "正在初始化编辑器…",
    loadingTab: (title) => `正在载入 ${title}`,
    emptyTitle: "打开文档或新建文档，开始多标签编辑",
    emptyDescription: "支持多标签新建、打开、拖拽打开和保存。",
    outlineHeader: "目录",
    outlineEmpty: "当前文档没有可展示的标题。",
    outlinePrompt: "打开文档后显示目录。",
    dropToOpen: "松开以打开 Markdown 文档",
    dropUnsupportedOverlay: "仅支持 .md / .markdown 文件",
    dropUnsupportedMessage: "仅支持拖拽打开 Markdown 文档。",
    noLocalDirectory: "当前标签没有对应的本地文件目录。",
    openedFolder: (title) => `已打开 ${title} 所在目录。`,
    openFolderFailed: (error) => `打开目录失败：${error}`,
    noCopyPath: "当前标签没有可复制的本地文件路径。",
    copiedFilePath: (title) => `已复制 ${title} 的文件路径。`,
    copyFailed: (error) => `复制文件路径失败：${error}`,
    contextSave: "保存",
    contextOpenFolder: "打开文件所在目录",
    contextCopyPath: "复制文件路径",
    contextClose: "关闭",
    loadedTab: (title) => `已加载 ${title}`,
    recoveredSuffix: "（已恢复）",
    fileRecovered: (title) => `文件已不可用，已将 ${title} 恢复为临时文档。`,
    loadFailed: (title, error) => `加载 ${title} 失败：${error}`,
    restoredSession: (count) => `已恢复上次打开的 ${count} 个文档。`,
    restoreFailed: (error) => `恢复编辑状态失败：${error}`,
    saveSessionFailed: (error) => `保存编辑状态失败：${error}`,
    imageFolderPrompt: (folder) =>
      `输入图片保存目录（相对当前文档目录）。\n当前值：${folder}\n留空会恢复为默认目录 ${DEFAULT_IMAGE_FOLDER}`,
    imageFolderUpdated: (folder) => `图片保存目录已设置为 ${folder}`,
    imageFolderInvalid: "图片目录无效，只支持相对路径，且不能包含 ..",
    imageRequiresSavedDocument: "请先保存当前文档，再插入图片。",
    imageInsertFailed: (error) => `插入图片失败：${error}`,
    imageInserted: (name) => `已插入图片 ${name}`,
    confirmCloseDirtyTab: (title) => `“${title}”尚未保存。关闭前先保存吗？`,
    confirmCloseDirtyWindow: (count) =>
      `当前有 ${count} 个未保存文档。关闭应用前先保存吗？`,
    unsavedSave: "保存",
    unsavedDiscard: "不保存",
    unsavedCancel: "取消",
  },
  "en-US": {
    menuOpen: "Open(O)",
    menuNew: "New(N)",
    menuSave: "Save(S)",
    menuImages: "Images(I)",
    menuLanguage: "Language(L)",
    languageChinese: "简体中文",
    languageEnglish: "English",
    languageChanged: "Interface language switched to English.",
    openDialogTitle: "Open Markdown Document",
    saveDialogTitle: "Save Document",
    readyMessage: "Create or open a Markdown document to start editing.",
    switchedTo: (title) => `Switched to ${title}`,
    openedFile: (title) => `Opened ${title}`,
    openedFiles: (count) => `Opened ${count} documents`,
    openFailed: (error) => `Failed to open document: ${error}`,
    loadingBeforeSave: (title) => `Loading ${title}. Please wait before saving.`,
    saveCanceled: "Save canceled.",
    saveConflict: (title) => `Save failed: ${title} is already open in another tab.`,
    saveSuccess: (title) => `Saved ${title}`,
    saveFailed: (error) => `Save failed: ${error}`,
    untitledPrefix: "Untitled-",
    createdDocument: (title) => `Created ${title}. Choose a file name and location when saving.`,
    editModeLabel: "Edit Mode",
    viewLabel: "View",
    modeSource: "Source",
    outlineLabel: "Outline",
    working: "Working…",
    loading: "Loading",
    untitledUnsaved: "Untitled / Unsaved",
    untitled: "Untitled",
    unsaved: "Unsaved",
    saved: "Saved",
    editorInitializing: "Initializing editor…",
    loadingTab: (title) => `Loading ${title}`,
    emptyTitle: "Open or create a document to start editing with tabs",
    emptyDescription: "Supports new tabs, opening files, drag and drop, and saving.",
    outlineHeader: "Outline",
    outlineEmpty: "No headings are available in the current document.",
    outlinePrompt: "Open a document to show its outline.",
    dropToOpen: "Drop to open the Markdown document",
    dropUnsupportedOverlay: "Only .md / .markdown files are supported",
    dropUnsupportedMessage: "Only Markdown documents can be opened by drag and drop.",
    noLocalDirectory: "The current tab does not have a local file directory.",
    openedFolder: (title) => `Opened the folder for ${title}.`,
    openFolderFailed: (error) => `Failed to open folder: ${error}`,
    noCopyPath: "The current tab does not have a local file path to copy.",
    copiedFilePath: (title) => `Copied the file path for ${title}.`,
    copyFailed: (error) => `Failed to copy file path: ${error}`,
    contextSave: "Save",
    contextOpenFolder: "Open File Location",
    contextCopyPath: "Copy File Path",
    contextClose: "Close",
    loadedTab: (title) => `Loaded ${title}`,
    recoveredSuffix: " (Recovered)",
    fileRecovered: (title) => `${title} is unavailable and has been restored as a temporary document.`,
    loadFailed: (title, error) => `Failed to load ${title}: ${error}`,
    restoredSession: (count) => `Restored ${count} documents from the last session.`,
    restoreFailed: (error) => `Failed to restore editor session: ${error}`,
    saveSessionFailed: (error) => `Failed to save editor session: ${error}`,
    imageFolderPrompt: (folder) =>
      `Enter the image folder relative to the current document.\nCurrent value: ${folder}\nLeave it empty to reset to ${DEFAULT_IMAGE_FOLDER}`,
    imageFolderUpdated: (folder) => `Image folder set to ${folder}`,
    imageFolderInvalid: "Invalid image folder. Only relative paths without .. are allowed.",
    imageRequiresSavedDocument: "Save the current document before inserting images.",
    imageInsertFailed: (error) => `Failed to insert image: ${error}`,
    imageInserted: (name) => `Inserted image ${name}`,
    confirmCloseDirtyTab: (title) => `“${title}” has unsaved changes. Save before closing?`,
    confirmCloseDirtyWindow: (count) =>
      `${count} document(s) have unsaved changes. Save before closing the app?`,
    unsavedSave: "Save",
    unsavedDiscard: "Don't Save",
    unsavedCancel: "Cancel",
  },
};

const getInitialLanguage = (): UiLanguage => {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === "zh-CN" || stored === "en-US") {
    return stored;
  }

  return window.navigator.language.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";
};

const sanitizeImageFolderInput = (value: string) => {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (!normalized) {
    return DEFAULT_IMAGE_FOLDER;
  }

  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("..")) {
    return null;
  }

  const parts = normalized.split("/").filter((part) => part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || part.length === 0)) {
    return null;
  }

  return parts.join("/");
};

const getInitialImageFolder = () => {
  if (typeof window === "undefined") {
    return DEFAULT_IMAGE_FOLDER;
  }

  const stored = window.localStorage.getItem(IMAGE_FOLDER_STORAGE_KEY);
  if (!stored) {
    return DEFAULT_IMAGE_FOLDER;
  }

  return sanitizeImageFolderInput(stored) ?? DEFAULT_IMAGE_FOLDER;
};

const isImagePath = (path: string) => {
  const normalized = normalizeDroppedPath(path);
  return normalized
    ? /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(normalized)
    : false;
};

const isImageFile = (file: File) =>
  file.type.startsWith("image/") ||
  /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);

const getClipboardImageFileName = (file: File) => {
  if (file.name.trim()) {
    return file.name;
  }

  const mimeType = file.type.toLowerCase();
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/svg+xml"
      ? "svg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : mimeType === "image/bmp"
            ? "bmp"
            : mimeType === "image/avif"
              ? "avif"
              : "png";
  return `pasted-image.${extension}`;
};

const getImageAltText = (fileName: string) => {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  const normalized = baseName.replace(/[_-]+/g, " ").replace(/[\[\]]/g, "").trim();
  return normalized || "image";
};

const createImageMarkdown = (markdownPath: string, fileName: string) =>
  `![${getImageAltText(fileName)}](${markdownPath})`;

const normalizeHeadingTitle = (value: string) =>
  value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();

const extractOutlineItems = (markdown: string): OutlineItem[] => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items: OutlineItem[] = [];
  let activeFence: "`" | "~" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0] as "`" | "~";
      if (activeFence === null) {
        activeFence = fenceChar;
      } else if (activeFence === fenceChar) {
        activeFence = null;
      }
      continue;
    }

    if (activeFence) {
      continue;
    }

    const atxHeading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (atxHeading) {
      const title = normalizeHeadingTitle(atxHeading[2]);
      if (title) {
        items.push({
          id: `heading-${items.length + 1}`,
          level: atxHeading[1].length,
          title,
          line: index + 1,
        });
      }
      continue;
    }

    const nextLine = lines[index + 1]?.trim();
    if (!line.trim() || !nextLine || !/^(=+|-+)\s*$/.test(nextLine)) {
      continue;
    }

    const title = normalizeHeadingTitle(line);
    if (!title) {
      continue;
    }

    items.push({
      id: `heading-${items.length + 1}`,
      level: nextLine.includes("=") ? 1 : 2,
      title,
      line: index + 1,
    });
    index += 1;
  }

  return items;
};

const getLineStartOffset = (text: string, line: number) => {
  if (line <= 1) {
    return 0;
  }

  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < text.length) {
    const nextBreak = text.indexOf("\n", offset);
    if (nextBreak === -1) {
      return text.length;
    }
    offset = nextBreak + 1;
    currentLine += 1;
  }

  return offset;
};

const getOutlineIdForLine = (items: OutlineItem[], line: number) => {
  let activeId: string | null = null;
  for (const item of items) {
    if (item.line <= line) {
      activeId = item.id;
      continue;
    }
    break;
  }

  return activeId ?? items[0]?.id ?? null;
};

const getRichHeadingElements = (root: HTMLDivElement | null) =>
  root
    ? Array.from(
        root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
      )
    : [];

export default function App() {
  const initialLanguageRef = useRef<UiLanguage>(getInitialLanguage());
  const initialImageFolderRef = useRef(getInitialImageFolder());
  const dragKindRef = useRef<"idle" | "valid" | "invalid">("invalid");
  const dragDepthRef = useRef(0);
  const internalDragRef = useRef(false);
  const tabsRef = useRef<EditorTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const allowWindowCloseRef = useRef(false);
  const loadingTabIdsRef = useRef(new Set<string>());
  const sessionReadyRef = useRef(false);
  const sourceEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const [language, setLanguage] = useState<UiLanguage>(initialLanguageRef.current);
  const [imageFolder, setImageFolder] = useState(initialImageFolderRef.current);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragState, setDragState] = useState<"idle" | "valid" | "invalid">("idle");
  const [editorMode, setEditorMode] = useState<EditorMode>("rich");
  const [showOutline, setShowOutline] = useState(true);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [richEditorRoot, setRichEditorRoot] = useState<HTMLDivElement | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [message, setMessage] = useState(
    UI_TEXT[initialLanguageRef.current].readyMessage,
  );
  const t = UI_TEXT[language];

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const currentWindowTitle = activeTab ? `${activeTab.title} ${APP_NAME}` : APP_NAME;
  const contextMenuTab = useMemo(
    () => tabs.find((tab) => tab.id === tabContextMenu?.tabId) ?? null,
    [tabs, tabContextMenu],
  );
  const outlineItems = useMemo(
    () => (activeTab?.loaded ? extractOutlineItems(activeTab.content) : []),
    [activeTab?.loaded, activeTab?.content],
  );

  const promptUnsavedDecision = async (
    messageText: string,
  ): Promise<"save" | "discard" | "cancel"> => {
    const result = await showDialogMessage(messageText, {
      title: APP_NAME,
      kind: "warning",
      buttons: {
        yes: t.unsavedSave,
        no: t.unsavedDiscard,
        cancel: t.unsavedCancel,
      },
    });

    if (result === t.unsavedSave) {
      return "save";
    }

    if (result === t.unsavedDiscard) {
      return "discard";
    }

    return "cancel";
  };

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    window.localStorage.setItem(IMAGE_FOLDER_STORAGE_KEY, imageFolder);
  }, [imageFolder]);

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
        setMessage(t.switchedTo(targetTab?.title ?? getFileName(lastExisting)));
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
          ? t.openedFile(loadedTabs[0].title)
          : t.openedFiles(loadedTabs.length),
      );
    } catch (error) {
      setMessage(t.openFailed(String(error)));
    } finally {
      setBusy(false);
    }
  };

  const openDroppedMarkdownFiles = async (files: File[]) => {
    const markdownFiles = files.filter(isMarkdownFile);
    if (markdownFiles.length === 0) {
      return;
    }

    const pathBackedFiles = markdownFiles
      .map((file) => ({
        file,
        path: normalizeDroppedPath((file as DroppedFileWithPath).path ?? ""),
      }))
      .filter((entry): entry is { file: File; path: string } => Boolean(entry.path));

    const pathBackedPaths = pathBackedFiles.map((entry) => entry.path);
    const pathBackedNames = new Set(pathBackedFiles.map((entry) => entry.file.name));
    const temporaryFiles = markdownFiles.filter((file) => !pathBackedNames.has(file.name));

    if (pathBackedPaths.length > 0) {
      await openPaths(pathBackedPaths);
    }

    if (temporaryFiles.length === 0) {
      return;
    }

    setBusy(true);
    try {
      const loadedTabs = await Promise.all(
        temporaryFiles.map(async (file, index) => {
          const content = await file.text();
          const title = file.name;
          const id = `${TEMP_PREFIX}drop:${Date.now()}:${index}:${title}`;
          const nextTab: EditorTab = {
            id,
            path: null,
            title,
            content,
            savedContent: content,
            dirty: false,
            temporary: true,
            loaded: true,
          };
          return nextTab;
        }),
      );

      setTabs((current) => [...current, ...loadedTabs]);
      setActiveTabId(loadedTabs[loadedTabs.length - 1]?.id ?? activeTabIdRef.current);
      setMessage(
        loadedTabs.length === 1
          ? t.openedFile(loadedTabs[0].title)
          : t.openedFiles(loadedTabs.length),
      );
    } catch (error) {
      setMessage(t.openFailed(String(error)));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFiles = async () => {
    const result = await open({
      directory: false,
      multiple: true,
      title: t.openDialogTitle,
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
      return false;
    }

    if (!tab.loaded) {
      setMessage(t.loadingBeforeSave(tab.title));
      return false;
    }

    setBusy(true);
    try {
      let targetPath = tab.path;
      if (tab.temporary || !targetPath) {
        const suggested = tab.title.endsWith(".md") ? tab.title : `${tab.title}.md`;
        const result = await save({
          title: t.saveDialogTitle,
          defaultPath: suggested,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });

        if (!result || Array.isArray(result)) {
          setMessage(t.saveCanceled);
          return false;
        }

        targetPath = String(result);
      }

      const conflict = tabs.find(
        (item) => item.id !== tab.id && item.path === targetPath,
      );
      if (conflict) {
        setMessage(t.saveConflict(getFileName(targetPath)));
        return false;
      }

      const nextContent = tab.temporary
        ? await invoke<string>("save_temporary_markdown_file", {
            tabId: tab.id,
            path: targetPath,
            content: tab.content,
          })
        : tab.content;

      if (!tab.temporary) {
        await invoke("save_markdown_file", {
          path: targetPath,
          content: tab.content,
        });
      }

      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id
            ? {
                ...item,
                id: targetPath!,
                path: targetPath!,
                title: getFileName(targetPath!),
                content: nextContent,
                savedContent: nextContent,
                dirty: false,
                temporary: false,
                loaded: true,
              }
            : item,
        ),
      );
      setActiveTabId(targetPath);
      setMessage(t.saveSuccess(getFileName(targetPath)));
      return true;
    } catch (error) {
      setMessage(t.saveFailed(String(error)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const closeTabImmediately = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabIdRef.current === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const cleanupTemporaryTab = async (tab: EditorTab) => {
    if (!tab.temporary) {
      return;
    }

    await invoke("delete_temporary_document", {
      tabId: tab.id,
    }).catch(() => {});
  };

  const handleCloseTab = async (id: string) => {
    const targetTab = tabsRef.current.find((tab) => tab.id === id);
    if (!targetTab) {
      return;
    }

    if (targetTab.dirty) {
      const decision = await promptUnsavedDecision(
        t.confirmCloseDirtyTab(targetTab.title),
      );
      if (decision === "cancel") {
        return;
      }

      if (decision === "save") {
        const saved = await handleSaveTab(targetTab);
        if (!saved) {
          return;
        }
      } else {
        await cleanupTemporaryTab(targetTab);
      }
    }

    closeTabImmediately(targetTab.id);
  };

  const saveDirtyTabsBeforeWindowClose = async () => {
    const dirtyTabs = tabsRef.current.filter((tab) => tab.dirty);
    if (dirtyTabs.length === 0) {
      return true;
    }

    const decision = await promptUnsavedDecision(
      t.confirmCloseDirtyWindow(dirtyTabs.length),
    );
    if (decision === "cancel") {
      return false;
    }

    if (decision === "save") {
      for (const tab of dirtyTabs) {
        const saved = await handleSaveTab(tab);
        if (!saved) {
          return false;
        }
      }
      return true;
    }

    await Promise.all(dirtyTabs.map((tab) => cleanupTemporaryTab(tab)));
    return true;
  };

  const handleCreateDocument = () => {
    const index = tabs.filter((tab) => tab.temporary).length + 1;
    const title = `${t.untitledPrefix}${index}.md`;
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
    setMessage(t.createdDocument(title));
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

  const syncActiveOutline = useEffectEvent(() => {
    if (!showOutline || outlineItems.length === 0) {
      setActiveOutlineId(null);
      return;
    }

    if (editorMode === "source") {
      const textarea = sourceEditorRef.current;
      if (!textarea) {
        setActiveOutlineId(outlineItems[0]?.id ?? null);
        return;
      }

      const cursorOffset = textarea.selectionStart ?? 0;
      const line =
        textarea.value.slice(0, cursorOffset).split("\n").length;
      setActiveOutlineId(getOutlineIdForLine(outlineItems, line));
      return;
    }

    if (!richEditorRoot) {
      setActiveOutlineId(outlineItems[0]?.id ?? null);
      return;
    }

    const headings = getRichHeadingElements(richEditorRoot);

    if (headings.length === 0) {
      setActiveOutlineId(outlineItems[0]?.id ?? null);
      return;
    }

    const scrollContainer = richEditorRoot.closest(".editor-shell");
    const containerTop = scrollContainer instanceof HTMLElement
      ? scrollContainer.getBoundingClientRect().top
      : 0;
    const threshold = containerTop + 72;

    let nextActiveIndex = 0;
    headings.forEach((heading, index) => {
      if (heading.getBoundingClientRect().top <= threshold) {
        nextActiveIndex = index;
      }
    });

    setActiveOutlineId(outlineItems[nextActiveIndex]?.id ?? outlineItems[0]?.id ?? null);
  });

  const handleOutlineSelect = (item: OutlineItem) => {
    if (!activeTab?.loaded) {
      return;
    }

    if (editorMode === "source") {
      const textarea = sourceEditorRef.current;
      if (!textarea) {
        return;
      }

      const offset = getLineStartOffset(activeTab.content, item.line);
      const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 22;
      const targetLine = Math.max(0, item.line - 3);
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      textarea.scrollTop = targetLine * lineHeight;
      setActiveOutlineId(item.id);
      return;
    }

    const outlineIndex = outlineItems.findIndex((outline) => outline.id === item.id);
    const headings = getRichHeadingElements(richEditorRoot);
    const target =
      (outlineIndex >= 0 ? headings[outlineIndex] : null) ??
      headings.find((heading) => {
        const level = Number.parseInt(heading.tagName.slice(1), 10);
        return (
          level === item.level &&
          normalizeHeadingTitle(heading.textContent ?? "") === item.title
        );
      });
    if (!target) {
      return;
    }

    target.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
    setActiveOutlineId(item.id);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.lang = language;
    document.title = currentWindowTitle;
    void getCurrentWindow().setTitle(currentWindowTitle).catch(() => {});
  }, [currentWindowTitle, language]);

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (allowWindowCloseRef.current) {
          return;
        }

        event.preventDefault();
        const canClose = await saveDirtyTabsBeforeWindowClose();
        if (!canClose) {
          return;
        }

        allowWindowCloseRef.current = true;
        try {
          await getCurrentWindow().close();
        } finally {
          allowWindowCloseRef.current = false;
        }
      })
      .then((dispose) => {
        unlisten = dispose;
      });

    return () => {
      unlisten?.();
    };
  }, [saveDirtyTabsBeforeWindowClose]);

  useEffect(() => {
    if (!showOutline || editorMode !== "source") {
      return;
    }

    const textarea = sourceEditorRef.current;
    if (!textarea) {
      return;
    }

    const handleSelectionChange = () => {
      syncActiveOutline();
    };

    syncActiveOutline();
    textarea.addEventListener("click", handleSelectionChange);
    textarea.addEventListener("input", handleSelectionChange);
    textarea.addEventListener("keyup", handleSelectionChange);
    textarea.addEventListener("select", handleSelectionChange);

    return () => {
      textarea.removeEventListener("click", handleSelectionChange);
      textarea.removeEventListener("input", handleSelectionChange);
      textarea.removeEventListener("keyup", handleSelectionChange);
      textarea.removeEventListener("select", handleSelectionChange);
    };
  }, [showOutline, editorMode, activeTab?.id, syncActiveOutline]);

  useEffect(() => {
    if (!showOutline || editorMode !== "rich" || !richEditorRoot) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      syncActiveOutline();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    showOutline,
    editorMode,
    richEditorRoot,
    activeTab?.id,
    activeTab?.content,
    syncActiveOutline,
  ]);

  useEffect(() => {
    if (!showOutline || editorMode !== "rich" || !richEditorRoot) {
      return;
    }

    const scrollContainer = richEditorRoot.closest(".editor-shell");
    if (!(scrollContainer instanceof HTMLElement)) {
      return;
    }

    const handleOutlineChange = () => {
      syncActiveOutline();
    };

    scrollContainer.addEventListener("scroll", handleOutlineChange, { passive: true });
    window.addEventListener("resize", handleOutlineChange);
    window.addEventListener("pointerup", handleOutlineChange);
    window.addEventListener("keyup", handleOutlineChange);

    return () => {
      scrollContainer.removeEventListener("scroll", handleOutlineChange);
      window.removeEventListener("resize", handleOutlineChange);
      window.removeEventListener("pointerup", handleOutlineChange);
      window.removeEventListener("keyup", handleOutlineChange);
    };
  }, [showOutline, editorMode, richEditorRoot, activeTab?.id, syncActiveOutline]);

  useEffect(() => {
    if (!showOutline || editorMode !== "rich" || !richEditorRoot) {
      return;
    }

    const runSync = () => {
      window.requestAnimationFrame(() => {
        syncActiveOutline();
      });
    };

    runSync();
    const observer = new MutationObserver(() => {
      runSync();
    });

    observer.observe(richEditorRoot, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [
    showOutline,
    editorMode,
    richEditorRoot,
    activeTab?.id,
    syncActiveOutline,
  ]);

  useEffect(() => {
    if (!showOutline || outlineItems.length === 0) {
      setActiveOutlineId(null);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      syncActiveOutline();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [showOutline, editorMode, activeTab?.id, activeTab?.content, syncActiveOutline]);

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
          setMessage(t.loadedTab(targetTab.title));
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
                    title: getRecoveredTabTitle(tab.title, t.recoveredSuffix),
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
          setMessage(t.fileRecovered(targetTab.title));
          return;
        }

        if (closed && activeTabIdRef.current === targetTab.id) {
          setActiveTabId(nextActiveId);
        }
        setMessage(t.loadFailed(targetTab.title, String(error)));
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
          setMessage(t.restoredSession(session.tabs.length));
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(t.restoreFailed(String(error)));
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
        setMessage(t.saveSessionFailed(String(error)));
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [tabs, activeTabId]);

  useEffect(() => {
    if (!languageMenuOpen) {
      return;
    }

    const closeMenu = () => setLanguageMenuOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && languageMenuRef.current?.contains(target)) {
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

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", closeMenu);
    };
  }, [languageMenuOpen]);

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
      return;
    }

    void openPaths(markdownPaths);
  });

  const handleDroppedFiles = useEffectEvent((files: File[]) => {
    const markdownFiles = files.filter(isMarkdownFile);
    if (markdownFiles.length === 0) {
      return;
    }

    void openDroppedMarkdownFiles(markdownFiles);
  });

  const saveImageAssetFromFile = async (file: File) => {
    if (!activeTab || !activeTab.loaded) {
      setMessage(t.loading);
      return null;
    }

    try {
      let documentPath = activeTab.path;
      if (activeTab.temporary) {
        documentPath =
          activeTab.path ??
          (await invoke<string>("ensure_temporary_document_path", {
            tabId: activeTab.id,
          }));
        setTabs((current) =>
          current.map((tab) =>
            tab.id === activeTab.id
              ? {
                  ...tab,
                  path: documentPath,
                }
              : tab,
          ),
        );
      }

      if (!documentPath) {
        setMessage(t.imageRequiresSavedDocument);
        return null;
      }

      const fileName = getClipboardImageFileName(file);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const markdownPath = await invoke<string>("save_image_asset", {
        documentPath,
        assetsDir: imageFolder,
        fileName,
        bytes,
      });
      setMessage(t.imageInserted(getFileName(markdownPath)));
      return {
        markdownPath,
        fileName,
      };
    } catch (error) {
      setMessage(t.imageInsertFailed(String(error)));
      return null;
    }
  };

  const handleConfigureImageFolder = () => {
    const result = window.prompt(t.imageFolderPrompt(imageFolder), imageFolder);
    if (result === null) {
      return;
    }

    const nextFolder = sanitizeImageFolderInput(result);
    if (!nextFolder) {
      setMessage(t.imageFolderInvalid);
      return;
    }

    setImageFolder(nextFolder);
    setMessage(t.imageFolderUpdated(nextFolder));
  };

  const insertImageIntoSourceEditor = async (file: File) => {
    const result = await saveImageAssetFromFile(file);
    if (!result || !activeTab) {
      return;
    }

    const snippet = createImageMarkdown(result.markdownPath, result.fileName);
    const textarea = sourceEditorRef.current;
    const selectionStart = textarea?.selectionStart ?? activeTab.content.length;
    const selectionEnd = textarea?.selectionEnd ?? activeTab.content.length;
    const before = activeTab.content.slice(0, selectionStart);
    const after = activeTab.content.slice(selectionEnd);
    const prefix = before.endsWith("\n") || before.length === 0 ? "" : "\n";
    const suffix = after.startsWith("\n") || after.length === 0 ? "" : "\n";
    const inserted = `${prefix}${snippet}${suffix}`;
    const nextContent = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;

    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              content: nextContent,
              dirty: nextContent !== tab.savedContent,
            }
          : tab,
      ),
    );

    if (textarea) {
      window.requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    }
  };

  const handleSourceEditorPaste = async (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/"),
    );
    const file = imageItem?.getAsFile();
    if (!file) {
      return;
    }

    event.preventDefault();
    await insertImageIntoSourceEditor(file);
  };

  const handleSourceEditorDragOver = (
    event: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    const hasImage = Array.from(event.dataTransfer.files).some(isImageFile);
    if (!hasImage) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleSourceEditorDrop = async (
    event: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    const file = Array.from(event.dataTransfer.files).find(isImageFile);
    if (!file) {
      return;
    }

    event.preventDefault();
    await insertImageIntoSourceEditor(file);
  };

  const handleChangeLanguage = (nextLanguage: UiLanguage) => {
    setLanguage(nextLanguage);
    setLanguageMenuOpen(false);
    setMessage(UI_TEXT[nextLanguage].languageChanged);
  };

  const handleOpenTabFolder = async () => {
    if (!canUseLocalFilePath(contextMenuTab)) {
      setMessage(t.noLocalDirectory);
      setTabContextMenu(null);
      return;
    }

    const targetTab = contextMenuTab;
    try {
      await invoke("open_file_location", { path: targetTab.path });
      setMessage(t.openedFolder(targetTab.title));
    } catch (error) {
      setMessage(t.openFolderFailed(String(error)));
    } finally {
      setTabContextMenu(null);
    }
  };

  const handleCopyContextTabPath = async () => {
    if (!canUseLocalFilePath(contextMenuTab)) {
      setMessage(t.noCopyPath);
      setTabContextMenu(null);
      return;
    }

    const targetTab = contextMenuTab;
    try {
      await copyTextToClipboard(targetTab.path);
      setMessage(t.copiedFilePath(targetTab.title));
    } catch (error) {
      setMessage(t.copyFailed(String(error)));
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

    void handleCloseTab(contextMenuTab.id);
    setTabContextMenu(null);
  };

  useEffect(() => {
    const handleDocumentDragStart = (event: DragEvent) => {
      const target = event.target;
      const isInsideApp =
        target instanceof Element ? Boolean(target.closest(".app-shell")) : false;
      const hasFiles = Boolean(event.dataTransfer?.files.length);
      internalDragRef.current = isInsideApp && !hasFiles;
      logAppDrag("document-dragstart", {
        target: describeDragTarget(target),
        isInsideApp,
        hasFiles,
        types: event.dataTransfer ? Array.from(event.dataTransfer.types) : [],
        internal: internalDragRef.current,
      });
    };

    const clearInternalDrag = (event: DragEvent) => {
      logAppDrag("document-drag-end", {
        target: describeDragTarget(event.target),
        internal: internalDragRef.current,
      });
      internalDragRef.current = false;
    };

    document.addEventListener("dragstart", handleDocumentDragStart, true);
    document.addEventListener("dragend", clearInternalDrag, true);
    document.addEventListener("drop", clearInternalDrag, true);

    return () => {
      document.removeEventListener("dragstart", handleDocumentDragStart, true);
      document.removeEventListener("dragend", clearInternalDrag, true);
      document.removeEventListener("drop", clearInternalDrag, true);
    };
  }, []);

  useEffect(() => {
    const hasExternalFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const resolveDragKind = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const fileNames = files.map((file) => file.name);
      if (fileNames.some((name) => /\.(md|markdown)$/i.test(name))) {
        return "valid" as const;
      }

      if (files.some(isImageFile)) {
        return "idle" as const;
      }

      return "invalid" as const;
    };

    const clearExternalDragState = () => {
      dragDepthRef.current = 0;
      dragKindRef.current = "idle";
      setDragState("idle");
    };

    const handleDocumentDragEnter = (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }

      dragDepthRef.current += 1;
      dragKindRef.current = resolveDragKind(event);
      logAppDrag("document-file-dragenter", {
        target: describeDragTarget(event.target),
        dragKind: dragKindRef.current,
        files: Array.from(event.dataTransfer?.files ?? []).map((file) => file.name),
      });
      event.preventDefault();
      if (dragKindRef.current !== "idle") {
        setDragState(dragKindRef.current);
      }
    };

    const handleDocumentDragOver = (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }

      event.preventDefault();
      dragKindRef.current = resolveDragKind(event);
      if (dragKindRef.current !== "idle") {
        setDragState(dragKindRef.current);
      } else {
        setDragState("idle");
      }
    };

    const handleDocumentDragLeave = (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }

      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      logAppDrag("document-file-dragleave", {
        target: describeDragTarget(event.target),
        dragDepth: dragDepthRef.current,
      });
      if (dragDepthRef.current === 0) {
        clearExternalDragState();
      }
    };

    const handleDocumentDrop = (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }

      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = getDroppedPathsFromDataTransfer(event.dataTransfer);
      logAppDrag("document-file-drop", {
        target: describeDragTarget(event.target),
        files: files.map((file) => ({
          name: file.name,
          path: (file as DroppedFileWithPath).path ?? null,
        })),
        paths,
      });

      clearExternalDragState();
      event.preventDefault();
      if (paths.length > 0) {
        void handleDroppedPaths(paths);
        return;
      }

      void handleDroppedFiles(files);
    };

    document.addEventListener("dragenter", handleDocumentDragEnter, true);
    document.addEventListener("dragover", handleDocumentDragOver, true);
    document.addEventListener("dragleave", handleDocumentDragLeave, true);
    document.addEventListener("drop", handleDocumentDrop, true);

    return () => {
      document.removeEventListener("dragenter", handleDocumentDragEnter, true);
      document.removeEventListener("dragover", handleDocumentDragOver, true);
      document.removeEventListener("dragleave", handleDocumentDragLeave, true);
      document.removeEventListener("drop", handleDocumentDrop, true);
    };
  }, [handleDroppedFiles, handleDroppedPaths]);

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
              type="button"
              className="menu-button"
              onClick={() => void handleOpenFiles()}
            >
              {t.menuOpen}
            </button>
            <button
              type="button"
              className="menu-button"
              onClick={handleCreateDocument}
            >
              {t.menuNew}
            </button>
            <button
              type="button"
              className="menu-button"
              onClick={() => void handleSaveTab()}
              disabled={!activeTab || !activeTab.loaded}
            >
              {t.menuSave}
            </button>
            <div className="header-menu" ref={languageMenuRef}>
              <button
                type="button"
                className={`menu-button ${languageMenuOpen ? "is-active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={languageMenuOpen}
                onClick={() => setLanguageMenuOpen((current) => !current)}
              >
                {t.menuLanguage}
              </button>
              {languageMenuOpen ? (
                <div className="menu-popup" role="menu">
                  <button
                    type="button"
                    className={`menu-popup__item ${language === "zh-CN" ? "is-active" : ""}`}
                    onClick={() => handleChangeLanguage("zh-CN")}
                  >
                    {t.languageChinese}
                  </button>
                  <button
                    type="button"
                    className={`menu-popup__item ${language === "en-US" ? "is-active" : ""}`}
                    onClick={() => handleChangeLanguage("en-US")}
                  >
                    {t.languageEnglish}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="toolbar-title">{currentWindowTitle}</div>
        </div>

        <TabsBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={(id) => {
            void handleCloseTab(id);
          }}
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
                    ref={sourceEditorRef}
                    value={activeTab.content}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    onPaste={(event) => void handleSourceEditorPaste(event)}
                    onDragOver={handleSourceEditorDragOver}
                    onDrop={(event) => void handleSourceEditorDrop(event)}
                    onChange={(event) =>
                      handleSourceEditorChange(activeTab.id, event.target.value)
                    }
                  />
                </div>
              ) : (
                <Suspense
                  fallback={(
                    <div className="editor-loading">
                      <h3>{t.editorInitializing}</h3>
                    </div>
                  )}
                >
                  <LazyMilkdownEditor
                    key={activeTab.id}
                    docKey={activeTab.id}
                    ref={setRichEditorRoot}
                    documentPath={activeTab.path}
                    markdown={activeTab.content}
                    onInsertImage={async (file) => {
                      const result = await saveImageAssetFromFile(file);
                      return result
                        ? createImageMarkdown(result.markdownPath, result.fileName)
                        : null;
                    }}
                    onChange={(content) => {
                      handleRichEditorChange(activeTab.id, content);
                    }}
                  />
                </Suspense>
              )
            ) : (
              <div className="editor-loading">
                <h3>{t.loadingTab(activeTab.title)}</h3>
              </div>
            )
          ) : (
            <div className="empty-state">
              <h3>{t.emptyTitle}</h3>
              <p>{t.emptyDescription}</p>
            </div>
          )}
        </div>

        <div className="status-bar">
          <span className="status-bar__message">{message}</span>
          <div className="status-bar__right">
            <div className="status-toggle" role="group" aria-label={t.editModeLabel}>
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
                {t.modeSource}
              </button>
            </div>
            <div className="status-toggle" role="group" aria-label={t.viewLabel}>
              <button
                type="button"
                className={`status-toggle__button ${showOutline ? "is-active" : ""}`}
                aria-pressed={showOutline}
                onClick={() => setShowOutline((current) => !current)}
              >
                {t.outlineLabel}
              </button>
            </div>
            <span>
            {busy
              ? t.working
              : activeTab && !activeTab.loaded
                ? t.loading
                : activeTab?.temporary
                ? activeTab.dirty
                  ? t.untitledUnsaved
                  : t.untitled
                : activeTab?.dirty
                  ? t.unsaved
                  : t.saved}
            </span>
          </div>
        </div>
      </main>

      {showOutline ? (
        <aside className="toc-pane pane">
          <div className="pane-header pane-header--caption">
            <span className="pane-header__label">{t.outlineHeader}</span>
          </div>
          {activeTab ? (
            outlineItems.length > 0 ? (
              <div className="toc-list">
                {outlineItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`toc-item ${activeOutlineId === item.id ? "is-active" : ""}`}
                    style={{
                      paddingLeft: `${10 + (item.level - 1) * 14}px`,
                    }}
                    onClick={() => handleOutlineSelect(item)}
                  >
                    <span className="toc-item__level">H{item.level}</span>
                    <span className="toc-item__text">{item.title}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="toc-empty">{t.outlineEmpty}</div>
            )
          ) : (
            <div className="toc-empty">{t.outlinePrompt}</div>
          )}
        </aside>
      ) : null}

      {dragState !== "idle" ? (
        <div
          className={`drag-overlay ${dragState === "valid" ? "is-valid" : "is-invalid"}`}
        >
          <div className="drag-overlay__card">
            <strong>
              {dragState === "valid"
                ? t.dropToOpen
                : t.dropUnsupportedOverlay}
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
            {t.contextSave}
          </button>
          <button
            className="tab-context-menu__item"
            onClick={() => void handleOpenTabFolder()}
            disabled={!canUseLocalFilePath(contextMenuTab)}
          >
            {t.contextOpenFolder}
          </button>
          <button
            className="tab-context-menu__item"
            onClick={() => void handleCopyContextTabPath()}
            disabled={!canUseLocalFilePath(contextMenuTab)}
          >
            {t.contextCopyPath}
          </button>
          <button
            className="tab-context-menu__item"
            onClick={handleCloseContextTab}
          >
            {t.contextClose}
          </button>
        </div>
      ) : null}
    </div>
  );
}
