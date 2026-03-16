import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    let cancelled = false;
    void appWindow.isMaximized().then((val) => {
      if (!cancelled) setMaximized(val);
    });
    const unlisten = appWindow.onResized(() => {
      void appWindow.isMaximized().then((val) => {
        if (!cancelled) setMaximized(val);
      });
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleMinimize = useCallback(() => {
    void appWindow.minimize();
  }, []);

  const handleMaximize = useCallback(() => {
    if (maximized) {
      void appWindow.unmaximize();
    } else {
      void appWindow.maximize();
    }
  }, [maximized]);

  const handleClose = useCallback(() => {
    void appWindow.close();
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar__title" data-tauri-drag-region>
        {t("app.name")}
      </span>
      <div className="titlebar__controls">
        <button
          type="button"
          className="titlebar__btn"
          onClick={handleMinimize}
          aria-label={t("titlebar.minimize")}
          title={t("titlebar.minimize")}
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__btn"
          onClick={handleMaximize}
          aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                d="M2 0h6a2 2 0 012 2v6a2 2 0 01-2 2H2a2 2 0 01-2-2V2a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h6a.5.5 0 00.5-.5V2a.5.5 0 00-.5-.5H2z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--close"
          onClick={handleClose}
          aria-label={t("titlebar.close")}
          title={t("titlebar.close")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
