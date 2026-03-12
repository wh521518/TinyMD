export type EditorTab = {
  id: string;
  path: string | null;
  title: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  temporary: boolean;
  loaded: boolean;
};
