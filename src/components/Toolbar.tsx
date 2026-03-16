import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ViewState } from "../lib/constants";

export function Toolbar({
  heading,
  undoCount,
  redoCount,
  viewState,
  onLoad,
  onUndo,
  onRedo,
  onOpenCommandPalette,
}: {
  heading: string;
  undoCount: number;
  redoCount: number;
  viewState: ViewState;
  onLoad: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenCommandPalette?: () => void;
}) {
  const { t } = useTranslation();
  const isBusy = viewState === "loading" || viewState === "saving";
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        overflowRef.current &&
        !overflowRef.current.contains(e.target as Node)
      ) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [overflowOpen]);

  return (
    <div className="toolbar">
      <span className="toolbar__title">{heading}</span>
      {onOpenCommandPalette && (
        <button
          type="button"
          className="toolbar__btn toolbar__btn--search"
          onClick={onOpenCommandPalette}
          title={t("toolbar.commandPalette")}
        >
          <span className="toolbar__icon">⌘</span>
          <span className="toolbar__shortcut">{t("toolbar.shortcut")}</span>
        </button>
      )}
      <div className="toolbar__actions">
        <div className="toolbar__group">
          <button
            type="button"
            className="toolbar__btn toolbar__btn--secondary"
            onClick={onUndo}
            disabled={undoCount === 0}
            title={t("toolbar.undo")}
          >
            ↩
            {undoCount > 0 && (
              <span className="toolbar__badge">{undoCount}</span>
            )}
          </button>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--secondary"
            onClick={onRedo}
            disabled={redoCount === 0}
            title={t("toolbar.redo")}
          >
            ↪
          </button>
        </div>
        {viewState === "saving" && (
          <span className="toolbar__status">{t("toolbar.saving")}</span>
        )}
        <div className="toolbar__overflow" ref={overflowRef}>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--secondary"
            onClick={() => setOverflowOpen(!overflowOpen)}
            title={t("toolbar.overflow")}
          >
            ⋯
          </button>
          {overflowOpen && (
            <div className="toolbar__overflow-menu">
              <button
                type="button"
                className="toolbar__overflow-item"
                onClick={() => {
                  onLoad();
                  setOverflowOpen(false);
                }}
                disabled={isBusy}
              >
                {t("toolbar.reload")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
