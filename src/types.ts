export type TabStorageKind = "saved" | "draft" | "temporaryFile" | "recovered";

export type EditorTab = {
  id: string;
  path: string | null;
  sourcePath: string | null;
  title: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  storageKind: TabStorageKind;
  loaded: boolean;
};
