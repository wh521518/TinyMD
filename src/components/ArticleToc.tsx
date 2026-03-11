import type { TocItem } from "../types";

type ArticleTocProps = {
  items: TocItem[];
  onJump: (item: TocItem) => void;
};

export function ArticleToc({ items, onJump }: ArticleTocProps) {
  if (items.length === 0) {
    return <div className="toc-empty">当前文档还没有标题结构</div>;
  }

  return (
    <div className="toc-list">
      {items.map((item) => (
        <button
          key={`${item.slug}-${item.index}`}
          className="toc-item"
          style={{ paddingLeft: `${12 + (item.level - 1) * 16}px` }}
          onClick={() => onJump(item)}
        >
          <span className="toc-item__level">H{item.level}</span>
          <span className="toc-item__text">{item.text}</span>
        </button>
      ))}
    </div>
  );
}
