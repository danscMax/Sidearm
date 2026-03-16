import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../i18n";
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
  const { t, i18n } = useTranslation();
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
          <span className="toolbar__icon">&#x2318;</span>
          <span className="toolbar__shortcut">{t("toolbar.shortcut")}</span>
        </button>
      )}
      <div className="toolbar__actions">
        {viewState === "saving" && (
          <span className="toolbar__status">{t("toolbar.saving")}</span>
        )}

        <button
          type="button"
          className="toolbar__lang"
          onClick={() => changeLanguage(i18n.language === "ru" ? "en" : "ru")}
          title={t("settings.languageHeader")}
        >
          {i18n.language.toUpperCase()}
        </button>

        <button
          type="button"
          className="toolbar__icon-btn"
          onClick={onUndo}
          disabled={undoCount === 0}
          title={t("toolbar.undo")}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M3 7h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 4L3 7l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {undoCount > 0 && (
            <span className="toolbar__badge">{undoCount}</span>
          )}
        </button>
        <button
          type="button"
          className="toolbar__icon-btn"
          onClick={onRedo}
          disabled={redoCount === 0}
          title={t("toolbar.redo")}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M13 7H6a3 3 0 000 6h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10 4l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div className="toolbar__overflow" ref={overflowRef}>
          <button
            type="button"
            className="toolbar__icon-btn"
            onClick={() => setOverflowOpen(!overflowOpen)}
            title={t("toolbar.overflow")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="3" cy="8" r="1.5" fill="currentColor"/>
              <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
              <circle cx="13" cy="8" r="1.5" fill="currentColor"/>
            </svg>
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
