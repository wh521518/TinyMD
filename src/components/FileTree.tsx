import clsx from "clsx";
import type { TreeNode } from "../types";

type FileTreeProps = {
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelect: (node: TreeNode) => void;
  onOpenFile: (path: string) => void;
};

type TreeItemProps = FileTreeProps & {
  node: TreeNode;
  depth: number;
};

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onOpenFile,
}: TreeItemProps) {
  const isSelected = node.path === selectedPath;

  return (
    <div>
      <button
        className={clsx("tree-item", isSelected && "is-selected")}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          onSelect(node);
          if (node.kind === "file") {
            onOpenFile(node.path);
          }
        }}
      >
        <span className="tree-item__icon">
          {node.kind === "folder" ? "▾" : "•"}
        </span>
        <span className="tree-item__label">{node.name}</span>
      </button>

      {node.kind === "folder" &&
        node.children?.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onOpenFile={onOpenFile}
            nodes={[]}
          />
        ))}
    </div>
  );
}

export function FileTree(props: FileTreeProps) {
  return (
    <div className="tree-list">
      {props.nodes.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}
