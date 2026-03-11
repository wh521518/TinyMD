export type TreeNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children?: TreeNode[];
};

export type EditorTab = {
  id: string;
  path: string | null;
  title: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  temporary: boolean;
};

export type TocItem = {
  level: number;
  text: string;
  slug: string;
  index: number;
};
