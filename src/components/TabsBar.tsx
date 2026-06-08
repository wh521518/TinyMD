import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import type { WheelEvent } from "react";
import type { EditorTab } from "../types";

type TabsBarProps = {
  tabs: EditorTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (tab: EditorTab, position: { x: number; y: number }) => void;
};

// 悬浮提示出现延迟（毫秒）。原生 title 约 500ms，这里更跟手。
const TOOLTIP_DELAY = 120;

type TooltipState = { text: string; x: number; y: number };

export function TabsBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onContextMenu,
}: TabsBarProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);

  const clearTooltipTimer = () => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  };

  const hideTooltip = () => {
    clearTooltipTimer();
    setTooltip(null);
  };

  const showTooltip = (text: string, target: HTMLElement) => {
    clearTooltipTimer();
    const rect = target.getBoundingClientRect();
    tooltipTimerRef.current = window.setTimeout(() => {
      setTooltip({ text, x: rect.left, y: rect.bottom + 4 });
    }, TOOLTIP_DELAY);
  };

  useEffect(() => clearTooltipTimer, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const container = event.currentTarget;

    if (container.scrollWidth <= container.clientWidth) {
      return;
    }

    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;

    if (delta === 0) {
      return;
    }

    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, container.scrollLeft + delta),
    );

    if (nextScrollLeft === container.scrollLeft) {
      return;
    }

    event.preventDefault();
    container.scrollLeft = nextScrollLeft;
    hideTooltip();
  };

  if (tabs.length === 0) {
    return <div className="tabs-bar is-empty" aria-hidden="true" />;
  }

  return (
    <>
      <div className="tabs-bar" onWheel={handleWheel}>
        {tabs.map((tab) => {
          const tooltipText = tab.sourcePath ?? tab.path ?? tab.title;
          return (
            <button
              key={tab.id}
              className={clsx("tab-chip", tab.id === activeTabId && "is-active")}
              onClick={() => onActivate(tab.id)}
              onMouseEnter={(event) =>
                showTooltip(tooltipText, event.currentTarget)
              }
              onMouseLeave={hideTooltip}
              onContextMenu={(event) => {
                event.preventDefault();
                hideTooltip();
                onContextMenu(tab, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <span className="tab-chip__title">
                {tab.dirty ? <span className="tab-chip__dirty-marker">* </span> : null}
                <span
                  className={clsx("tab-chip__title-text", tab.dirty && "is-dirty")}
                >
                  {tab.title}
                </span>
              </span>
              <span
                className="tab-chip__close"
                onClick={(event) => {
                  event.stopPropagation();
                  hideTooltip();
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
          );
        })}
      </div>
      {tooltip ? (
        <div
          className="tab-tooltip"
          role="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      ) : null}
    </>
  );
}
