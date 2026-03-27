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
import { listen } from "@tauri-apps/api/event";
import {
  open,
  save,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { TabsBar } from "./components/TabsBar";
import {
  ASSET_IMPORT_STATUS_DOM_EVENT,
  publishAttachmentImportState,
  type AttachmentImportState,
} from "./lib/attachmentImportState";
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

const isMarkdownFileName = (name: string) => /\.(md|markdown)$/i.test(name.trim());

const isMarkdownFile = (file: File) => isMarkdownFileName(file.name);

type DroppedFileWithPath = File & {
  path?: string;
};

type AssetImportStatusPayload = {
  documentPath: string;
  relativePath: string;
  fileName: string;
  status: "completed" | "failed";
  error?: string | null;
};

type AssetUploadSession = {
  uploadId: string;
  relativePath: string;
  fileName: string;
};

type AssetDirectoryStatus = {
  path: string;
  exists: boolean;
};

type LocalAssetMetadata = {
  fileName: string;
  sizeBytes: number;
  modifiedUnixMs?: number | null;
  extension?: string | null;
};

type NativeDropSnapshot = {
  paths: string[];
  timestamp: number;
};

type DroppedAssetPathsPayload = {
  paths: string[];
  position: {
    x: number;
    y: number;
  };
};

const getDroppedFilePath = (file: File) =>
  normalizeDroppedPath((file as DroppedFileWithPath).path ?? "");

const hasExternalFileTransfer = (dataTransfer: DataTransfer | null) =>
  Array.from(dataTransfer?.types ?? []).includes("Files");

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

  const transferPayloads = ["text/uri-list", "text/plain", "URL"]
    .map((type) => dataTransfer.getData(type))
    .filter(Boolean);

  if (transferPayloads.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      transferPayloads
        .flatMap((payload) => payload.split(/\r?\n/))
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("#"))
        .map(normalizeDroppedPath)
        .filter((path): path is string => Boolean(path)),
    ),
  );
};

const matchDroppedPathsToFiles = (files: File[], candidatePaths: string[]) => {
  const normalizedCandidates = candidatePaths
    .map(normalizeDroppedPath)
    .filter((path): path is string => Boolean(path));
  const usedCandidateIndexes = new Set<number>();

  return files.map((file) => {
    const directPath = getDroppedFilePath(file);
    if (directPath) {
      return directPath;
    }

    const fileName = file.name.trim().toLowerCase();
    if (!fileName) {
      return null;
    }

    const matchedIndex = normalizedCandidates.findIndex(
      (candidatePath, index) =>
        !usedCandidateIndexes.has(index) &&
        getFileName(candidatePath).trim().toLowerCase() === fileName,
    );

    if (matchedIndex < 0) {
      return null;
    }

    usedCandidateIndexes.add(matchedIndex);
    return normalizedCandidates[matchedIndex];
  });
};

type ExternalDragState = "idle" | "open" | "attach" | "moveToEditor" | "invalid";
const TEMP_DOCS_PATH_SEGMENT = "/temp-docs/";

const normalizeDocumentPathForStorageCheck = (path: string | null | undefined) =>
  path?.trim().replace(/\\/g, "/").toLowerCase() ?? "";

const isTemporaryDocumentPath = (path: string | null | undefined) =>
  !path || normalizeDocumentPathForStorageCheck(path).includes(TEMP_DOCS_PATH_SEGMENT);

const hasPersistedSourcePath = (path: string | null | undefined): path is string =>
  Boolean(path && !isTemporaryDocumentPath(path));

const getWorkingDocumentPath = (tab: EditorTab | null | undefined) => tab?.path ?? tab?.sourcePath ?? null;

const canUseLocalFilePath = (
  tab: EditorTab | null | undefined,
): tab is EditorTab & { sourcePath: string } =>
  hasPersistedSourcePath(tab?.sourcePath);

const isRecoveredTab = (tab: EditorTab | null | undefined) =>
  tab?.storageKind === "recovered";

const isDroppedTemporaryTab = (tab: EditorTab | null | undefined) =>
  tab?.storageKind === "temporaryFile";

const isUntitledDraftTab = (tab: EditorTab | null | undefined) =>
  tab?.storageKind === "draft";

const usesTemporaryDocumentStorage = (tab: EditorTab | null | undefined) =>
  !tab?.sourcePath || isTemporaryDocumentPath(tab?.path);

const requiresSaveAsPath = (tab: EditorTab | null | undefined) => !canUseLocalFilePath(tab);

const requiresSavedDocumentForLocalAssetImport = (
  tab: EditorTab | null | undefined,
  sourcePath: string | null | undefined,
  origin: "drop" | "paste",
) => (origin === "drop" || Boolean(sourcePath)) && !hasPersistedSourcePath(tab?.sourcePath);

const TEMP_PREFIX = "temp:";
const APP_NAME = "TinyMD";
const MAX_IN_MEMORY_ASSET_BYTES = 32 * 1024 * 1024;
const BACKGROUND_ASSET_IMPORT_BYTES = 16 * 1024 * 1024;
const STREAMED_ASSET_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const NATIVE_DROP_PATH_TTL_MS = 2000;
const APP_CLOSE_INTENT_EVENT = "app-close-intent";
const TRAY_REQUEST_EXIT_EVENT = "tray-request-exit";
const ASSET_IMPORT_STATUS_EVENT = "asset-import-status";
const OPEN_DROPPED_MARKDOWN_FILES_EVENT = "open-dropped-markdown-files";
const INSERT_DROPPED_ASSET_PATHS_EVENT = "insert-dropped-asset-paths";
const RECOVERED_PREFIX = "recovered:";
const LANGUAGE_STORAGE_KEY = "tinymd.language";
const IMAGE_FOLDER_STORAGE_KEY = "tinymd.imageFolder";
const DEFAULT_IMAGE_FOLDER = "_assets";
const LEGACY_DEFAULT_IMAGE_FOLDER = "assets";

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

const isEditorDropTarget = (value: EventTarget | null) =>
  value instanceof Element &&
  Boolean(value.closest(".editor-source__textarea, .editor-shell, .milkdown"));

const getElementFromPhysicalDropPosition = (position: { x: number; y: number }) => {
  const scale = window.devicePixelRatio || 1;
  return document.elementFromPoint(position.x / scale, position.y / scale);
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

type AppDialogAction = {
  id: string;
  label: string;
  tone?: "primary" | "ghost";
};

type AppDialogState = {
  title: string;
  message: string;
  actions: AppDialogAction[];
  defaultActionId?: string;
  cancelActionId?: string;
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
  dropToInsertAssets: string;
  dropMoveToEditorOverlay: string;
  dropUnsupportedOverlay: string;
  dropUnsupportedMessage: string;
  dropMoveToEditorMessage: string;
  dropOpenPathRequired: string;
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
  assetImportQueued: (name: string) => string;
  assetImportCompleted: (name: string) => string;
  assetImportFailed: (name: string, error: string) => string;
  attachmentImporting: string;
  attachmentImportFailed: string;
  waitingForAttachmentImports: string;
  clipboardAssetTooLarge: (name: string, size: string, limit: string) => string;
  attachmentOpenTitle: string;
  attachmentOpenConfirm: (name: string) => string;
  attachmentOpenAction: string;
  attachmentOpenCancel: string;
  attachmentRequiresSaveTitle: string;
  attachmentRequiresSaveConfirm: string;
  attachmentRequiresSaveAction: string;
  attachmentRequiresSaveCancel: string;
  assetDirectoryCreateTitle: string;
  assetDirectoryCreateConfirm: (path: string) => string;
  assetDirectoryUseConfirm: (path: string) => string;
  assetDirectoryRedirectConfirm: (path: string) => string;
  assetDirectoryCreateAction: string;
  assetDirectoryCreateCancel: string;
  confirmCloseDirtyTab: (title: string) => string;
  confirmCloseDirtyWindow: (count: number) => string;
  confirmCloseAction: string;
  closeActionExit: string;
  closeActionTray: string;
  closeActionCancel: string;
  minimizedToTray: string;
  unsavedSave: string;
  unsavedDiscard: string;
  unsavedCancel: string;
};

const UI_TEXT: Record<UiLanguage, UiText> = {
  "zh-CN": {
    menuOpen: "打开(O)",
    menuNew: "新建(N)",
    menuSave: "保存(S)",
    menuImages: "附件(I)",
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
    dropToInsertAssets: "松开以插入图片或附件",
    dropMoveToEditorOverlay: "将图片或附件拖到编辑器中插入",
    dropUnsupportedOverlay: "当前拖拽内容不支持",
    dropUnsupportedMessage: "仅支持拖拽打开 Markdown 文档。",
    dropMoveToEditorMessage: "请将图片或附件拖到编辑器中插入。",
    dropOpenPathRequired: "无法从这次拖拽中获取 Markdown 文件的本地路径，请改用“打开文档”或从资源管理器直接拖入。",
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
      `输入附件保存目录（相对当前文档目录）。\n当前值：${folder}\n留空会恢复为默认目录 ${DEFAULT_IMAGE_FOLDER}`,
    imageFolderUpdated: (folder) => `附件保存目录已设置为 ${folder}`,
    imageFolderInvalid: "附件目录无效，只支持相对路径，且不能包含 ..",
    imageRequiresSavedDocument: "请先保存当前文档，再插入附件。",
    imageInsertFailed: (error) => `插入附件失败：${error}`,
    imageInserted: (name) => `已插入附件 ${name}`,
    assetImportQueued: (name) => `已插入附件 ${name}，正在后台导入。`,
    assetImportCompleted: (name) => `附件 ${name} 已完成导入。`,
    assetImportFailed: (name, error) => `附件 ${name} 导入失败：${error}`,
    attachmentImporting: "正在导入...",
    attachmentImportFailed: "导入失败",
    waitingForAttachmentImports: "正在等待附件导入完成...",
    clipboardAssetTooLarge: (name, size, limit) =>
      `附件 ${name} 大小为 ${size}，超过剪贴板导入上限 ${limit}。请改用拖拽导入。`,
    attachmentOpenTitle: "打开附件",
    attachmentOpenConfirm: (name) => `确认打开附件“${name}”吗？`,
    attachmentOpenAction: "打开",
    attachmentOpenCancel: "取消",
    attachmentRequiresSaveTitle: "先保存文档",
    attachmentRequiresSaveConfirm: "临时文档暂不支持导入本地图片或附件，请先保存当前文档。",
    attachmentRequiresSaveAction: "保存",
    attachmentRequiresSaveCancel: "取消",
    assetDirectoryCreateTitle: "创建附件目录",
    assetDirectoryCreateConfirm: (path) =>
      `首次插入附件会在当前文档目录下创建附件目录：${path}。是否继续？`,
    assetDirectoryUseConfirm: (path) =>
      `首次插入附件会使用当前文档目录下的附件目录：${path}。是否继续？`,
    assetDirectoryRedirectConfirm: (path) =>
      `当前文档已包含其他本地图片或附件引用。继续后，新插入的附件会保存到指定目录：${path}。是否继续？`,
    assetDirectoryCreateAction: "继续",
    assetDirectoryCreateCancel: "取消",
    confirmCloseDirtyTab: (title) => `“${title}”尚未保存。关闭前先保存吗？`,
    confirmCloseDirtyWindow: (count) =>
      `当前有 ${count} 个未保存文档。关闭应用前先保存吗？`,
    confirmCloseAction: "关闭 TinyMD 时，是否退出应用，还是保存到托盘？",
    closeActionExit: "退出",
    closeActionTray: "保存到托盘",
    closeActionCancel: "取消",
    minimizedToTray: "应用已最小化到系统托盘。",
    unsavedSave: "保存",
    unsavedDiscard: "不保存",
    unsavedCancel: "取消",
  },
  "en-US": {
    menuOpen: "Open(O)",
    menuNew: "New(N)",
    menuSave: "Save(S)",
    menuImages: "Attachments(I)",
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
    dropToInsertAssets: "Drop to insert images or attachments",
    dropMoveToEditorOverlay: "Drop images or attachments into the editor to insert",
    dropUnsupportedOverlay: "The current dragged content is not supported",
    dropUnsupportedMessage: "Only Markdown documents can be opened by drag and drop.",
    dropMoveToEditorMessage: "Drop images or attachments into the editor to insert them.",
    dropOpenPathRequired:
      "The local path for the dragged Markdown file could not be resolved. Use Open Document or drag it directly from the file manager.",
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
      `Enter the attachment folder relative to the current document.\nCurrent value: ${folder}\nLeave it empty to reset to ${DEFAULT_IMAGE_FOLDER}`,
    imageFolderUpdated: (folder) => `Attachment folder set to ${folder}`,
    imageFolderInvalid: "Invalid attachment folder. Only relative paths without .. are allowed.",
    imageRequiresSavedDocument: "Save the current document before inserting attachments.",
    imageInsertFailed: (error) => `Failed to insert attachment: ${error}`,
    imageInserted: (name) => `Inserted attachment ${name}`,
    assetImportQueued: (name) => `Inserted attachment ${name}; importing in background.`,
    assetImportCompleted: (name) => `Finished importing attachment ${name}.`,
    assetImportFailed: (name, error) => `Failed to import attachment ${name}: ${error}`,
    attachmentImporting: "Importing...",
    attachmentImportFailed: "Import failed",
    waitingForAttachmentImports: "Waiting for attachments to finish importing...",
    clipboardAssetTooLarge: (name, size, limit) =>
      `Attachment ${name} is ${size}, which exceeds the clipboard import limit of ${limit}. Use drag and drop instead.`,
    attachmentOpenTitle: "Open Attachment",
    attachmentOpenConfirm: (name) => `Open attachment "${name}"?`,
    attachmentOpenAction: "Open",
    attachmentOpenCancel: "Cancel",
    attachmentRequiresSaveTitle: "Save Document First",
    attachmentRequiresSaveConfirm:
      "Local images and attachments require a saved document. Save the current document first.",
    attachmentRequiresSaveAction: "Save",
    attachmentRequiresSaveCancel: "Cancel",
    assetDirectoryCreateTitle: "Create Attachment Folder",
    assetDirectoryCreateConfirm: (path) =>
      `The first attachment will create an attachment folder in the current document directory: ${path}. Continue?`,
    assetDirectoryUseConfirm: (path) =>
      `The first attachment will use the attachment folder in the current document directory: ${path}. Continue?`,
    assetDirectoryRedirectConfirm: (path) =>
      `This document already contains other local image or attachment links. Continue and save newly inserted attachments to ${path}?`,
    assetDirectoryCreateAction: "Continue",
    assetDirectoryCreateCancel: "Cancel",
    confirmCloseDirtyTab: (title) => `“${title}” has unsaved changes. Save before closing?`,
    confirmCloseDirtyWindow: (count) =>
      `${count} document(s) have unsaved changes. Save before closing the app?`,
    confirmCloseAction: "When closing TinyMD, do you want to exit or keep it in the tray?",
    closeActionExit: "Exit",
    closeActionTray: "Keep in Tray",
    closeActionCancel: "Cancel",
    minimizedToTray: "TinyMD was minimized to the system tray.",
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

  const sanitized = sanitizeImageFolderInput(stored);
  if (!sanitized || sanitized === LEGACY_DEFAULT_IMAGE_FOLDER) {
    return DEFAULT_IMAGE_FOLDER;
  }

  return sanitized;
};

const formatAssetSize = (sizeBytes: number) => {
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

const isImagePath = (path: string) => {
  const normalized = normalizeDroppedPath(path);
  return normalized
    ? /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(normalized)
    : false;
};

const isImageFile = (file: File) =>
  file.type.startsWith("image/") ||
  /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);

const getClipboardAssetFileName = (file: File) => {
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
              : mimeType.split("/")[1]?.split("+")[0]?.replace(/[^a-z0-9-]/gi, "") || "bin";
  return `${file.type.startsWith("image/") ? "pasted-image" : "attachment"}.${extension}`;
};

const readBlobAsBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("无法读取附件分块"));
    };
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });

const getImageLabel = (fileName: string) => {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  const normalized = baseName.replace(/[_-]+/g, " ").replace(/[\[\]]/g, "").trim();
  return normalized || "attachment";
};

const getAttachmentLabel = (fileName: string) => {
  const normalized = fileName.trim().replace(/[\[\]]/g, "").trim();
  return normalized || "attachment";
};

const escapeMarkdownLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

const createAssetMarkdown = (
  markdownPath: string,
  fileName: string,
  options?: { image?: boolean },
) => {
  const label = escapeMarkdownLabel(
    options?.image ? getImageLabel(fileName) : getAttachmentLabel(fileName),
  );
  return options?.image
    ? `![${label}](<${markdownPath}>)`
    : `[${label}](<${markdownPath}>)`;
};

const normalizeMarkdownLinkTarget = (value: string) =>
  value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");

const isLocalMarkdownLinkTarget = (value: string) =>
  Boolean(value) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value);

const getDocumentAssetDirectoryUsage = (
  markdown: string,
  assetsDir: string,
): "configured" | "other" | "none" => {
  const normalizedAssetsDir = sanitizeImageFolderInput(assetsDir) ?? DEFAULT_IMAGE_FOLDER;
  const pattern = /(!?)\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  let hasOtherLocalAssetReference = false;

  for (const match of markdown.matchAll(pattern)) {
    const isImage = match[1] === "!";
    const target = normalizeMarkdownLinkTarget(match[2] ?? match[3] ?? "");

    if (!isLocalMarkdownLinkTarget(target)) {
      continue;
    }

    if (!isImage && /\.(md|markdown)(?:$|[?#])/i.test(target)) {
      continue;
    }

    if (target === normalizedAssetsDir || target.startsWith(`${normalizedAssetsDir}/`)) {
      return "configured";
    }

    hasOtherLocalAssetReference = true;
  }

  return hasOtherLocalAssetReference ? "other" : "none";
};

const getAttachableFiles = (files: Iterable<File>) =>
  Array.from(files).filter((file) => !isMarkdownFile(file));

const joinAssetBlocks = (snippets: string[]) => snippets.join("\n\n");

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
  const dragKindRef = useRef<ExternalDragState>("idle");
  const dragDepthRef = useRef(0);
  const internalDragRef = useRef(false);
  const tabsRef = useRef<EditorTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const allowWindowCloseRef = useRef(false);
  const loadingTabIdsRef = useRef(new Set<string>());
  const sessionReadyRef = useRef(false);
  const latestNativeDropRef = useRef<NativeDropSnapshot | null>(null);
  const lastHandledNativeDropRef = useRef<{
    signature: string;
    timestamp: number;
  } | null>(null);
  const pendingAssetImportsRef = useRef(new Map<string, Set<string>>());
  const pendingAssetImportWaitersRef = useRef(new Map<string, Set<() => void>>());
  const appDialogResolverRef = useRef<((result: string | null) => void) | null>(null);
  const confirmDialogPrimaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const [language, setLanguage] = useState<UiLanguage>(initialLanguageRef.current);
  const [imageFolder, setImageFolder] = useState(initialImageFolderRef.current);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragState, setDragState] = useState<ExternalDragState>("idle");
  const [editorMode, setEditorMode] = useState<EditorMode>("rich");
  const [showOutline, setShowOutline] = useState(true);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [richEditorRoot, setRichEditorRoot] = useState<HTMLDivElement | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [appDialog, setAppDialog] = useState<AppDialogState | null>(null);
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

  const closeAppDialog = useEffectEvent((result: string | null) => {
    const resolver = appDialogResolverRef.current;
    appDialogResolverRef.current = null;
    setAppDialog(null);
    resolver?.(result);
  });

  const showAppDialog = useEffectEvent(
    (dialog: AppDialogState) =>
      new Promise<string | null>((resolve) => {
        const pending = appDialogResolverRef.current;
        if (pending) {
          pending(null);
        }

        appDialogResolverRef.current = resolve;
        setAppDialog(dialog);
      }),
  );

  const showConfirmDialog = useEffectEvent(
    async (dialog: {
      title: string;
      message: string;
      okLabel: string;
      cancelLabel: string;
    }) => {
      const result = await showAppDialog({
        title: dialog.title,
        message: dialog.message,
        actions: [
          { id: "cancel", label: dialog.cancelLabel, tone: "ghost" },
          { id: "ok", label: dialog.okLabel, tone: "primary" },
        ],
        defaultActionId: "ok",
        cancelActionId: "cancel",
      });

      return result === "ok";
    },
  );

  const resolveDroppedSourcePaths = useEffectEvent(
    (files: File[], dataTransfer: DataTransfer | null) => {
      const transferPaths = getDroppedPathsFromDataTransfer(dataTransfer);
      const recentNativeDrop =
        hasExternalFileTransfer(dataTransfer) &&
        latestNativeDropRef.current &&
        Date.now() - latestNativeDropRef.current.timestamp <= NATIVE_DROP_PATH_TTL_MS
          ? latestNativeDropRef.current.paths
          : [];

      return matchDroppedPathsToFiles(
        files,
        transferPaths.length > 0 ? transferPaths : recentNativeDrop,
      );
    },
  );

  const getRecentNativeDropPaths = useEffectEvent(() => {
    if (
      latestNativeDropRef.current &&
      Date.now() - latestNativeDropRef.current.timestamp <= NATIVE_DROP_PATH_TTL_MS
    ) {
      return latestNativeDropRef.current.paths;
    }

    return [];
  });

  const resolveDroppedPaths = useEffectEvent((dataTransfer: DataTransfer | null) => {
    const transferPaths = getDroppedPathsFromDataTransfer(dataTransfer);
    if (transferPaths.length > 0) {
      return transferPaths;
    }

    return hasExternalFileTransfer(dataTransfer) ? getRecentNativeDropPaths() : [];
  });

  const waitForPendingAssetImports = useEffectEvent(async (documentPath: string | null | undefined) => {
    if (!documentPath) {
      return;
    }

    const pending = pendingAssetImportsRef.current.get(documentPath);
    if (!pending || pending.size === 0) {
      return;
    }

    setMessage(t.waitingForAttachmentImports);
    await new Promise<void>((resolve) => {
      const waiters = pendingAssetImportWaitersRef.current.get(documentPath) ?? new Set();
      waiters.add(resolve);
      pendingAssetImportWaitersRef.current.set(documentPath, waiters);
    });
  });

  const promptUnsavedDecision = async (
    messageText: string,
  ): Promise<"save" | "discard" | "cancel"> => {
    const result = await showAppDialog({
      title: APP_NAME,
      message: messageText,
      actions: [
        { id: "cancel", label: t.unsavedCancel, tone: "ghost" },
        { id: "discard", label: t.unsavedDiscard, tone: "ghost" },
        { id: "save", label: t.unsavedSave, tone: "primary" },
      ],
      defaultActionId: "save",
      cancelActionId: "cancel",
    });

    if (result === "save") {
      return "save";
    }

    if (result === "discard") {
      return "discard";
    }

    return "cancel";
  };

  const promptCloseAction = async (): Promise<"exit" | "tray" | "cancel"> => {
    const result = await showAppDialog({
      title: APP_NAME,
      message: t.confirmCloseAction,
      actions: [
        { id: "cancel", label: t.closeActionCancel, tone: "ghost" },
        { id: "tray", label: t.closeActionTray, tone: "ghost" },
        { id: "exit", label: t.closeActionExit, tone: "primary" },
      ],
      defaultActionId: "exit",
      cancelActionId: "cancel",
    });

    if (result === "exit") {
      return "exit";
    }

    if (result === "tray") {
      return "tray";
    }

    return "cancel";
  };

  const saveEditorSessionSnapshot = useEffectEvent(async (
    sessionTabs = tabsRef.current,
    sessionActiveTabId = activeTabIdRef.current,
  ) => {
    try {
      await invoke("save_editor_session", {
        session: {
          tabs: sessionTabs,
          activeTabId: sessionActiveTabId,
        },
      });
      return true;
    } catch (error) {
      setMessage(t.saveSessionFailed(String(error)));
      return false;
    }
  });

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
      availableTabs
        .filter((tab) => tab.sourcePath)
        .map((tab) => [tab.sourcePath as string, tab]),
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
            sourcePath: path,
            title: getFileName(path),
            content,
            savedContent: content,
            dirty: false,
            storageKind: "saved",
            loaded: true,
          };
          return nextTab;
        }),
      );

      setTabs((current) => {
        const existingPaths = new Set(
          current.filter((tab) => tab.sourcePath).map((tab) => tab.sourcePath as string),
        );
        const tabsToAppend = loadedTabs.filter(
          (tab) => !existingPaths.has(tab.sourcePath as string),
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
      let targetPath = canUseLocalFilePath(tab) ? tab.sourcePath : null;
      if (requiresSaveAsPath(tab) || !targetPath) {
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
        (item) => item.id !== tab.id && item.sourcePath === targetPath,
      );
      if (conflict) {
        setMessage(t.saveConflict(getFileName(targetPath)));
        return false;
      }

      if (usesTemporaryDocumentStorage(tab)) {
        await waitForPendingAssetImports(getWorkingDocumentPath(tab));
      }

      const nextContent = usesTemporaryDocumentStorage(tab)
        ? await invoke<string>("save_temporary_markdown_file", {
            tabId: tab.id,
            path: targetPath,
            content: tab.content,
          })
        : tab.content;

      if (!usesTemporaryDocumentStorage(tab)) {
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
                sourcePath: targetPath!,
                title: getFileName(targetPath!),
                content: nextContent,
                savedContent: nextContent,
                dirty: false,
                storageKind: "saved",
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
    if (!usesTemporaryDocumentStorage(tab)) {
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

  const exitApplication = async () => {
    const persisted = await saveEditorSessionSnapshot();
    if (!persisted) {
      return;
    }

    await invoke("request_app_exit");
  };

  const moveToTray = async () => {
    await invoke("move_main_window_to_tray");
    setMessage(t.minimizedToTray);
  };

  const handleCreateDocument = () => {
    const index = tabs.filter((tab) => isUntitledDraftTab(tab)).length + 1;
    const title = `${t.untitledPrefix}${index}.md`;
    const id = `${TEMP_PREFIX}${Date.now()}`;
    const nextTab: EditorTab = {
      id,
      path: null,
      sourcePath: null,
      title,
      content: "",
      savedContent: "",
      dirty: false,
      storageKind: "draft",
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

    void listen(TRAY_REQUEST_EXIT_EVENT, () => {
      void exitApplication();
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen<AssetImportStatusPayload>(ASSET_IMPORT_STATUS_EVENT, (event) => {
      const payload = event.payload;
      publishAttachmentImportState(payload);

      if (payload.status === "completed") {
        setMessage(t.assetImportCompleted(payload.fileName));
        return;
      }

      setMessage(t.assetImportFailed(payload.fileName, payload.error ?? "unknown error"));
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [t]);

  useEffect(() => {
    const handleAssetImportState = (event: Event) => {
      const payload = (event as CustomEvent<AttachmentImportState>).detail;
      const current = pendingAssetImportsRef.current.get(payload.documentPath) ?? new Set<string>();

      if (payload.status === "queued") {
        current.add(payload.relativePath);
        pendingAssetImportsRef.current.set(payload.documentPath, current);
        return;
      }

      if (current.size === 0) {
        return;
      }

      current.delete(payload.relativePath);
      if (current.size > 0) {
        pendingAssetImportsRef.current.set(payload.documentPath, current);
        return;
      }

      pendingAssetImportsRef.current.delete(payload.documentPath);
      const waiters = pendingAssetImportWaitersRef.current.get(payload.documentPath);
      if (!waiters) {
        return;
      }

      pendingAssetImportWaitersRef.current.delete(payload.documentPath);
      waiters.forEach((resolve) => resolve());
    };

    window.addEventListener(
      ASSET_IMPORT_STATUS_DOM_EVENT,
      handleAssetImportState as EventListener,
    );

    return () => {
      window.removeEventListener(
        ASSET_IMPORT_STATUS_DOM_EVENT,
        handleAssetImportState as EventListener,
      );
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let handlingClose = false;

    void listen(APP_CLOSE_INTENT_EVENT, async () => {
      if (handlingClose) {
        return;
      }

      handlingClose = true;
      try {
        const action = await promptCloseAction();
        if (action === "exit") {
          await exitApplication();
          return;
        }

        if (action === "tray") {
          await moveToTray();
        }
      } finally {
        handlingClose = false;
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [language, t]);

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
    if (!activeTab || activeTab.loaded || !canUseLocalFilePath(activeTab)) {
      return;
    }

    if (loadingTabIdsRef.current.has(activeTab.id)) {
      return;
    }

    loadingTabIdsRef.current.add(activeTab.id);
    const targetTab = activeTab;

    void invoke<string>("read_markdown_file", { path: targetTab.sourcePath })
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
                    sourcePath: null,
                    title: getRecoveredTabTitle(tab.title, t.recoveredSuffix),
                    content: snapshot,
                    savedContent: snapshot,
                    dirty: true,
                    storageKind: "recovered",
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
      void saveEditorSessionSnapshot(tabs, activeTabId);
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

  useEffect(() => {
    if (!appDialog) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      confirmDialogPrimaryButtonRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAppDialog(appDialog.cancelActionId ?? null);
        return;
      }

      if (
        event.key === "Enter" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        closeAppDialog(appDialog.defaultActionId ?? appDialog.actions[0]?.id ?? null);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [appDialog, closeAppDialog]);

  useEffect(() => () => {
    const resolver = appDialogResolverRef.current;
    appDialogResolverRef.current = null;
    resolver?.(null);
  }, []);

  const saveAssetFromLocalPath = async (
    sourcePath: string,
    origin: "drop" = "drop",
  ) => {
    if (!activeTab || !activeTab.loaded) {
      setMessage(t.loading);
      return null;
    }

    try {
      const normalizedSourcePath = normalizeDroppedPath(sourcePath) ?? sourcePath;
      const metadata = await invoke<LocalAssetMetadata>("read_local_asset_metadata", {
        path: normalizedSourcePath,
      });
      const fileName = metadata.fileName || getFileName(normalizedSourcePath);
      const isImage = isImagePath(normalizedSourcePath);
      const activeDocumentPath = activeTab.sourcePath ?? activeTab.path;
      const requiresSavedDocumentForLocalAsset = requiresSavedDocumentForLocalAssetImport(
        activeTab,
        normalizedSourcePath,
        origin,
      );

      logAppDrag("asset-import-context", {
        activeTabId: activeTab.id,
        activeTabTitle: activeTab.title,
        activeTabPath: activeTab.path,
        activeTabSourcePath: activeTab.sourcePath,
        activeTabStorageKind: activeTab.storageKind,
        origin,
        sourcePath: normalizedSourcePath,
        requiresSavedDocumentForLocalAsset,
      });

      if (requiresSavedDocumentForLocalAsset) {
        const shouldSaveFirst = await showConfirmDialog({
          title: t.attachmentRequiresSaveTitle,
          message: t.attachmentRequiresSaveConfirm,
          okLabel: t.attachmentRequiresSaveAction,
          cancelLabel: t.attachmentRequiresSaveCancel,
        });
        if (shouldSaveFirst) {
          await handleSaveTab();
        } else {
          setMessage(t.imageRequiresSavedDocument);
        }
        return null;
      }

      let documentPath = activeDocumentPath;
      if (usesTemporaryDocumentStorage(activeTab)) {
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

      if (canUseLocalFilePath(activeTab)) {
        const shouldCreateAssetDir = await confirmAssetDirectoryCreation(
          activeTab.sourcePath,
          activeTab.content,
        );
        if (!shouldCreateAssetDir) {
          return null;
        }
      }

      const queueImportFromPath =
        canUseLocalFilePath(activeTab) &&
        !isImage &&
        metadata.sizeBytes >= BACKGROUND_ASSET_IMPORT_BYTES;

      logAppDrag("asset-import-decision", {
        fileName,
        fileSize: metadata.sizeBytes,
        sourcePath: normalizedSourcePath,
        documentPath,
        activeDocumentPath,
        storageKind: activeTab.storageKind,
        queueImportFromPath,
        queueStreamedUpload: false,
      });

      const markdownPath = queueImportFromPath
        ? await invoke<string>("queue_asset_import_from_path", {
            documentPath,
            assetsDir: imageFolder,
            sourcePath: normalizedSourcePath,
            fileName,
          })
        : await invoke<string>("save_asset_from_path", {
            documentPath,
            assetsDir: imageFolder,
            sourcePath: normalizedSourcePath,
            fileName,
          });

      setMessage(
        queueImportFromPath
          ? t.assetImportQueued(getFileName(fileName))
          : t.imageInserted(getFileName(markdownPath)),
      );

      if (queueImportFromPath) {
        publishAttachmentImportState({
          documentPath,
          relativePath: markdownPath,
          fileName,
          status: "queued",
          error: null,
        });
      }

      return {
        markdownPath,
        fileName,
        isImage,
      };
    } catch (error) {
      setMessage(t.imageInsertFailed(String(error)));
      return null;
    }
  };

  const openLocalPathWithConfirmation = useEffectEvent(
    async (path: string, label?: string) => {
      const displayName = label?.trim() || getFileName(path);
      const confirmed = await showConfirmDialog({
        title: t.attachmentOpenTitle,
        message: t.attachmentOpenConfirm(displayName),
        okLabel: t.attachmentOpenAction,
        cancelLabel: t.attachmentOpenCancel,
      });

      if (!confirmed) {
        return;
      }

      await invoke("open_local_path", { path });
    },
  );

  const revealLocalPath = useEffectEvent(async (path: string, label?: string) => {
    const displayName = label?.trim() || getFileName(path);

    try {
      await invoke("open_file_location", { path });
      setMessage(t.openedFolder(displayName));
    } catch (error) {
      setMessage(t.openFolderFailed(String(error)));
    }
  });

  const streamAssetUpload = useEffectEvent(
    async (
      file: File,
      session: AssetUploadSession,
      documentPath: string,
    ) => {
      let uploadError: string | null = null;

      try {
        for (let offset = 0; offset < file.size; offset += STREAMED_ASSET_UPLOAD_CHUNK_BYTES) {
          const chunk = file.slice(offset, offset + STREAMED_ASSET_UPLOAD_CHUNK_BYTES);
          const base64Chunk = await readBlobAsBase64(chunk);
          await invoke("append_asset_upload_chunk", {
            uploadId: session.uploadId,
            base64Chunk,
          });
        }
      } catch (error) {
        uploadError = String(error);
      }

      logAppDrag("asset-stream-upload-finish", {
        fileName: session.fileName,
        documentPath,
        relativePath: session.relativePath,
        uploadId: session.uploadId,
        uploadError,
      });

      try {
        await invoke("finish_asset_upload", {
          uploadId: session.uploadId,
          error: uploadError,
        });
      } catch (error) {
        const fallbackError = uploadError ?? String(error);
        publishAttachmentImportState({
          documentPath,
          relativePath: session.relativePath,
          fileName: session.fileName,
          status: "failed",
          error: fallbackError,
        });
        setMessage(t.assetImportFailed(session.fileName, fallbackError));
        return fallbackError;
      }

      return uploadError;
    },
  );

  const confirmAssetDirectoryCreation = useEffectEvent(async (
    documentPath: string,
    markdown: string,
  ) => {
    const status = await invoke<AssetDirectoryStatus>("get_asset_directory_status", {
      documentPath,
      assetsDir: imageFolder,
    });

    const usage = getDocumentAssetDirectoryUsage(markdown, imageFolder);
    if (usage === "configured") {
      return true;
    }

    const message = usage === "other"
      ? t.assetDirectoryRedirectConfirm(status.path)
      : status.exists
        ? t.assetDirectoryUseConfirm(status.path)
        : t.assetDirectoryCreateConfirm(status.path);

    return showConfirmDialog({
      title: t.assetDirectoryCreateTitle,
      message,
      okLabel: t.assetDirectoryCreateAction,
      cancelLabel: t.assetDirectoryCreateCancel,
    });
  });

  const saveAssetFromFile = async (
    file: File,
    sourcePathOverride?: string | null,
    origin: "drop" | "paste" = "paste",
  ) => {
    if (!activeTab || !activeTab.loaded) {
      setMessage(t.loading);
      return null;
    }

    try {
      const fileName = getClipboardAssetFileName(file);
      const sourcePath = sourcePathOverride ?? getDroppedFilePath(file);
      const activeDocumentPath = activeTab.sourcePath ?? activeTab.path;
      const requiresSavedDocumentForLocalAsset = requiresSavedDocumentForLocalAssetImport(
        activeTab,
        sourcePath,
        origin,
      );

      logAppDrag("asset-import-context", {
        activeTabId: activeTab.id,
        activeTabTitle: activeTab.title,
        activeTabPath: activeTab.path,
        activeTabSourcePath: activeTab.sourcePath,
        activeTabStorageKind: activeTab.storageKind,
        origin,
        sourcePath,
        requiresSavedDocumentForLocalAsset,
      });

      if (requiresSavedDocumentForLocalAsset) {
        const shouldSaveFirst = await showConfirmDialog({
          title: t.attachmentRequiresSaveTitle,
          message: t.attachmentRequiresSaveConfirm,
          okLabel: t.attachmentRequiresSaveAction,
          cancelLabel: t.attachmentRequiresSaveCancel,
        });
        if (shouldSaveFirst) {
          await handleSaveTab();
        } else {
          setMessage(t.imageRequiresSavedDocument);
        }
        return null;
      }

      let documentPath = activeDocumentPath;
      if (usesTemporaryDocumentStorage(activeTab)) {
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

      if (canUseLocalFilePath(activeTab)) {
        const shouldCreateAssetDir = await confirmAssetDirectoryCreation(
          activeTab.sourcePath,
          activeTab.content,
        );
        if (!shouldCreateAssetDir) {
          return null;
        }
      }

      const requiresChunkedUpload =
        !sourcePath && !isImageFile(file) && file.size > MAX_IN_MEMORY_ASSET_BYTES;
      const queueImportFromPath =
        Boolean(sourcePath) &&
        canUseLocalFilePath(activeTab) &&
        !isImageFile(file) &&
        file.size >= BACKGROUND_ASSET_IMPORT_BYTES;
      const queueStreamedUpload =
        requiresChunkedUpload && !isImageFile(file);

      logAppDrag("asset-import-decision", {
        fileName,
        fileSize: file.size,
        sourcePath,
        documentPath,
        activeDocumentPath,
        storageKind: activeTab.storageKind,
        queueImportFromPath,
        queueStreamedUpload,
      });

      if (!sourcePath && !requiresChunkedUpload && file.size > MAX_IN_MEMORY_ASSET_BYTES) {
        throw new Error(
          t.clipboardAssetTooLarge(
            fileName,
            formatAssetSize(file.size),
            formatAssetSize(MAX_IN_MEMORY_ASSET_BYTES),
          ),
        );
      }

      const queuedUploadSession = requiresChunkedUpload
        ? await invoke<AssetUploadSession>("begin_asset_upload", {
            documentPath,
            assetsDir: imageFolder,
            fileName,
          })
        : null;
      if (queuedUploadSession) {
        logAppDrag("asset-stream-upload-start", {
          fileName: queuedUploadSession.fileName,
          documentPath,
          relativePath: queuedUploadSession.relativePath,
          uploadId: queuedUploadSession.uploadId,
          mode: usesTemporaryDocumentStorage(activeTab) ? "temporary-background" : "background",
        });
      }
      const markdownPath = queuedUploadSession
        ? queuedUploadSession.relativePath
        : queueImportFromPath
          ? await invoke<string>("queue_asset_import_from_path", {
            documentPath,
            assetsDir: imageFolder,
            sourcePath,
            fileName,
          })
        : sourcePath
          ? await invoke<string>("save_asset_from_path", {
            documentPath,
            assetsDir: imageFolder,
            sourcePath,
            fileName,
          })
          : await invoke<string>("save_asset", {
            documentPath,
            assetsDir: imageFolder,
            fileName,
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
          });
      if (queuedUploadSession) {
        void streamAssetUpload(file, queuedUploadSession, documentPath);
      }
      setMessage(
        queueImportFromPath || queuedUploadSession
          ? t.assetImportQueued(getFileName(fileName))
          : t.imageInserted(getFileName(markdownPath)),
      );
      if (queueImportFromPath || queuedUploadSession) {
        publishAttachmentImportState({
          documentPath,
          relativePath: markdownPath,
          fileName,
          status: "queued",
          error: null,
        });
      }
      return {
        markdownPath,
        fileName,
        isImage: isImageFile(file),
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

  const insertAssetsIntoSourceEditor = async (
    files: File[],
    sourcePaths: Array<string | null> = [],
    origin: "drop" | "paste" = "paste",
  ) => {
    if (!activeTab) {
      return;
    }

    const results = await Promise.all(
      files.map((file, index) => saveAssetFromFile(file, sourcePaths[index] ?? null, origin)),
    );
    const snippets = results
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .map((result) =>
        createAssetMarkdown(result.markdownPath, result.fileName, {
          image: result.isImage,
        }),
      );

    if (snippets.length === 0) {
      return;
    }

    const snippet = joinAssetBlocks(snippets);
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

  const insertAssetPathsIntoSourceEditor = useEffectEvent(async (paths: string[]) => {
    if (!activeTab) {
      return;
    }

    const attachablePaths = Array.from(
      new Set(paths.map(normalizeDroppedPath).filter((path): path is string => Boolean(path))),
    ).filter((path) => !isMarkdownPath(path));
    if (attachablePaths.length === 0) {
      return;
    }

    const results = await Promise.all(
      attachablePaths.map((path) => saveAssetFromLocalPath(path, "drop")),
    );
    const snippets = results
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .map((result) =>
        createAssetMarkdown(result.markdownPath, result.fileName, {
          image: result.isImage,
        }),
      );

    if (snippets.length === 0) {
      return;
    }

    const snippet = joinAssetBlocks(snippets);
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
  });

  const dispatchDroppedAssetPaths = useEffectEvent(
    (paths: string[], position: { x: number; y: number }) => {
      const attachablePaths = Array.from(
        new Set(paths.map(normalizeDroppedPath).filter((path): path is string => Boolean(path))),
      ).filter((path) => !isMarkdownPath(path));
      if (attachablePaths.length === 0) {
        return;
      }

      const target = getElementFromPhysicalDropPosition(position);
      const editorTarget = isEditorDropTarget(target);
      logAppDrag("native-insert-asset-paths-event", {
        paths: attachablePaths,
        target: describeDragTarget(target),
        editorTarget,
        editorMode,
      });

      if (!editorTarget) {
        setMessage(t.dropMoveToEditorMessage);
        return;
      }

      if (editorMode === "source") {
        void insertAssetPathsIntoSourceEditor(attachablePaths);
        return;
      }

      if (editorMode === "rich" && richEditorRoot) {
        richEditorRoot.dispatchEvent(
          new CustomEvent<{
            paths: string[];
            position: { x: number; y: number };
          }>(INSERT_DROPPED_ASSET_PATHS_EVENT, {
            detail: { paths: attachablePaths, position },
          }),
        );
      }
    },
  );

  const handleSourceEditorPaste = async (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const files = getAttachableFiles(
      Array.from(event.clipboardData.items)
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file)),
    );
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    await insertAssetsIntoSourceEditor(files, [], "paste");
  };

  const handleSourceEditorDragOver = (
    event: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    if (!hasExternalFileTransfer(event.dataTransfer)) {
      return;
    }

    const files = getAttachableFiles(event.dataTransfer.files);
    const droppedPaths = resolveDroppedPaths(event.dataTransfer);
    const attachablePaths = droppedPaths.filter((path) => !isMarkdownPath(path));
    if (files.length === 0 && attachablePaths.length === 0) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleSourceEditorDrop = async (
    event: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    if (!hasExternalFileTransfer(event.dataTransfer)) {
      return;
    }

    const files = getAttachableFiles(event.dataTransfer.files);
    const droppedPaths = resolveDroppedPaths(event.dataTransfer);
    const attachablePaths = droppedPaths.filter((path) => !isMarkdownPath(path));
    if (files.length === 0 && attachablePaths.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
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
      await invoke("open_file_location", { path: targetTab.sourcePath });
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
      await copyTextToClipboard(targetTab.sourcePath);
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
    let unlistenWindow: (() => void) | null = null;
    let unlistenWebview: (() => void) | null = null;

    const handleNativeDragDropEvent = (
      source: "window" | "webview",
      event: {
        payload:
          | { type: "enter"; paths: string[]; position: { x: number; y: number } }
          | { type: "drop"; paths: string[]; position: { x: number; y: number } }
          | { type: "over"; position: { x: number; y: number } }
          | { type: "leave" };
      },
    ) => {
      if (event.payload.type === "leave") {
        return;
      }

      if (event.payload.type === "enter" || event.payload.type === "drop") {
        const paths = event.payload.paths
          .map(normalizeDroppedPath)
          .filter((path): path is string => Boolean(path));
        latestNativeDropRef.current = {
          paths,
          timestamp: Date.now(),
        };
      }

      if (event.payload.type !== "drop") {
        return;
      }

      const paths = event.payload.paths
        .map(normalizeDroppedPath)
        .filter((path): path is string => Boolean(path));
      const target = getElementFromPhysicalDropPosition(event.payload.position);
      const editorTarget = isEditorDropTarget(target);
      const markdownPaths = getDroppedMarkdownPaths(paths);
      const hasAttachableNonMarkdown = paths.some((path) => !isMarkdownPath(path));

      logAppDrag("native-file-drop", {
        source,
        target: describeDragTarget(target),
        paths,
        editorTarget,
        markdownPaths,
        hasAttachableNonMarkdown,
      });

      const assetPaths = paths.filter((path) => !isMarkdownPath(path));
      const signature = JSON.stringify({
        markdownPaths,
        assetPaths,
        editorTarget,
      });
      const now = Date.now();
      if (
        lastHandledNativeDropRef.current &&
        lastHandledNativeDropRef.current.signature === signature &&
        now - lastHandledNativeDropRef.current.timestamp <= 500
      ) {
        logAppDrag("native-file-drop-deduped", {
          source,
          signature,
        });
        return;
      }

      lastHandledNativeDropRef.current = {
        signature,
        timestamp: now,
      };

      if (markdownPaths.length > 0) {
        logAppDrag("native-open-markdown-files-direct", {
          source,
          paths: markdownPaths,
        });
        void openPaths(markdownPaths);
        return;
      }

      if (assetPaths.length > 0) {
        dispatchDroppedAssetPaths(assetPaths, event.payload.position);
      }
    };

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        handleNativeDragDropEvent("window", event);
      })
      .then((dispose) => {
        unlistenWindow = dispose;
      })
      .catch(() => {});

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        handleNativeDragDropEvent("webview", event);
      })
      .then((dispose) => {
        unlistenWebview = dispose;
      })
      .catch(() => {});

    return () => {
      latestNativeDropRef.current = null;
      lastHandledNativeDropRef.current = null;
      unlistenWindow?.();
      unlistenWebview?.();
    };
  }, [dispatchDroppedAssetPaths, openPaths]);

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
    const hasExternalFiles = (event: DragEvent) => hasExternalFileTransfer(event.dataTransfer);

    const resolveDragKind = (event: DragEvent): ExternalDragState => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const transferPaths = getDroppedPathsFromDataTransfer(event.dataTransfer);
      const recentNativeDrop =
        latestNativeDropRef.current &&
        Date.now() - latestNativeDropRef.current.timestamp <= NATIVE_DROP_PATH_TTL_MS
          ? latestNativeDropRef.current.paths
          : [];
      const paths = transferPaths.length > 0 ? transferPaths : recentNativeDrop;
      const candidateNames = Array.from(
        new Set([
          ...files.map((file) => file.name.trim()),
          ...paths.map((path) => getFileName(path).trim()),
        ].filter(Boolean)),
      );

      if (candidateNames.length === 0) {
        return "idle";
      }

      const hasMarkdown = candidateNames.some(isMarkdownFileName);
      const hasAttachable = candidateNames.some((name) => !isMarkdownFileName(name));
      if (isEditorDropTarget(event.target) && hasAttachable) {
        return "attach";
      }

      if (hasMarkdown) {
        return "open";
      }

      if (hasAttachable) {
        return "moveToEditor";
      }

      return "invalid";
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
      setDragState(dragKindRef.current);
    };

    const handleDocumentDragOver = (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }

      event.preventDefault();
      dragKindRef.current = resolveDragKind(event);
      setDragState(dragKindRef.current);
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

    const handleDocumentDrop = async (event: DragEvent) => {
      if (internalDragRef.current || !hasExternalFiles(event)) {
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      const dragKind = resolveDragKind(event);
      const editorTarget = isEditorDropTarget(event.target);
      const transferPaths = getDroppedPathsFromDataTransfer(event.dataTransfer);
      const paths = transferPaths.length > 0 ? transferPaths : getRecentNativeDropPaths();
      const hasAttachableNonMarkdown =
        getAttachableFiles(files).some((file) => !isMarkdownFile(file)) ||
        paths.some((path) => !isMarkdownPath(path));
      logAppDrag("document-file-drop", {
        target: describeDragTarget(event.target),
        files: files.map((file) => ({
          name: file.name,
          path: (file as DroppedFileWithPath).path ?? null,
        })),
        transferTypes: event.dataTransfer ? Array.from(event.dataTransfer.types) : [],
        paths,
        editorTarget,
        hasAttachableNonMarkdown,
        dragKind,
      });

      event.preventDefault();
      clearExternalDragState();

      if (files.some(isMarkdownFile) || paths.some(isMarkdownPath)) {
        logAppDrag("document-file-drop-markdown-rust-owned", {
          target: describeDragTarget(event.target),
          paths,
          dragKind,
        });
        return;
      }

      if (!editorTarget && hasAttachableNonMarkdown) {
        setMessage(t.dropMoveToEditorMessage);
      }
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
  }, [getRecentNativeDropPaths, t.dropMoveToEditorMessage]);

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
            <button
              type="button"
              className="menu-button"
              onClick={handleConfigureImageFolder}
            >
              {t.menuImages}
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
                    documentPath={getWorkingDocumentPath(activeTab)}
                    markdown={activeTab.content}
                    attachmentRevealLabel={t.contextOpenFolder}
                    attachmentImportingLabel={t.attachmentImporting}
                    attachmentImportFailedLabel={t.attachmentImportFailed}
                    onOpenLocalPath={openLocalPathWithConfirmation}
                    onRevealLocalPath={revealLocalPath}
                    resolveDroppedSourcePaths={resolveDroppedSourcePaths}
                    resolveDroppedPaths={resolveDroppedPaths}
                    onInsertAsset={async (file, sourcePath, origin) => {
                      const result = await saveAssetFromFile(file, sourcePath, origin);
                      return result
                        ? createAssetMarkdown(result.markdownPath, result.fileName, {
                            image: result.isImage,
                          })
                        : null;
                    }}
                    onInsertAssetPath={async (sourcePath, origin) => {
                      const result = await saveAssetFromLocalPath(sourcePath, origin);
                      return result
                        ? createAssetMarkdown(result.markdownPath, result.fileName, {
                            image: result.isImage,
                          })
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
                : activeTab?.dirty
                  ? isUntitledDraftTab(activeTab)
                    ? t.untitledUnsaved
                    : t.unsaved
                  : canUseLocalFilePath(activeTab)
                    ? t.saved
                    : isUntitledDraftTab(activeTab)
                      ? t.untitled
                      : t.unsaved}
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
          className={`drag-overlay ${dragState === "open" || dragState === "attach" ? "is-valid" : "is-invalid"}`}
        >
          <div className="drag-overlay__card">
            <strong>
              {dragState === "open"
                ? t.dropToOpen
                : dragState === "attach"
                  ? t.dropToInsertAssets
                  : dragState === "moveToEditor"
                    ? t.dropMoveToEditorOverlay
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

      {appDialog ? (
        <div
          className="app-confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeAppDialog(appDialog.cancelActionId ?? null);
            }
          }}
        >
          <div
            className="app-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-confirm-dialog-title"
            aria-describedby="app-confirm-dialog-message"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="app-confirm-dialog__titlebar">
              <span id="app-confirm-dialog-title">{appDialog.title}</span>
            </div>
            <div className="app-confirm-dialog__body">
              <p id="app-confirm-dialog-message">{appDialog.message}</p>
            </div>
            <div className="app-confirm-dialog__actions">
              {appDialog.actions.map((action) => (
                <button
                  key={action.id}
                  ref={action.id === appDialog.defaultActionId ? confirmDialogPrimaryButtonRef : null}
                  type="button"
                  className={`app-confirm-dialog__button ${
                    action.tone === "primary" ? "primary-button" : "ghost-button"
                  }`}
                  onClick={() => closeAppDialog(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
