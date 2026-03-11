import clsx from "clsx";
import type { EditorTab } from "../types";

type TabsBarProps = {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
};

export function TabsBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: TabsBarProps) {
  return (
    <div className="tabs-bar">
      {tabs.length === 0 ? (
        <div className="tabs-empty">打开左侧 Markdown 文档开始编辑</div>
      ) : (
        tabs.map((tab) => (
          <button
            key={tab.id}
            className={clsx("tab-chip", tab.id === activeTabId && "is-active")}
            onClick={() => onActivate(tab.id)}
          >
            <span className="tab-chip__title">
              {tab.title}
              {tab.dirty ? " *" : ""}
            </span>
            <span
              className="tab-chip__close"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </span>
          </button>
        ))
      )}
    </div>
  );
}
