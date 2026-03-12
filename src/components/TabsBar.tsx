import clsx from "clsx";
import type { EditorTab } from "../types";

type TabsBarProps = {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (tab: EditorTab, position: { x: number; y: number }) => void;
};

export function TabsBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onContextMenu,
}: TabsBarProps) {
  if (tabs.length === 0) {
    return <div className="tabs-bar is-empty" aria-hidden="true" />;
  }

  return (
    <div className="tabs-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={clsx("tab-chip", tab.id === activeTabId && "is-active")}
          onClick={() => onActivate(tab.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu(tab, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
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
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            ×
          </span>
        </button>
      ))}
    </div>
  );
}
