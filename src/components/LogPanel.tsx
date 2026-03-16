import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { LogPanelControl } from "../hooks/useLogPanel";
import { openLogDirectory } from "../lib/backend";

export interface LogPanelProps {
  logPanel: LogPanelControl;
}

const levelClasses: Record<string, string> = {
  error: "badge--error",
  warn: "badge--warn",
  info: "badge--info",
  debug: "badge--debug",
  trace: "badge--debug",
};

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function LogPanel({ logPanel }: LogPanelProps) {
  const { t } = useTranslation();
  const {
    filteredLogs,
    categories,
    levelFilter,
    setLevelFilter,
    categoryFilter,
    setCategoryFilter,
    searchQuery,
    setSearchQuery,
    clearLogs,
  } = logPanel;

  const levelLabels: Record<string, string> = {
    all: t("log.levelAll"),
    error: t("log.levelError"),
    warn: t("log.levelWarn"),
    info: t("log.levelInfo"),
    debug: t("log.levelDebug"),
  };

  const badgeLabels: Record<string, string> = {
    error: t("log.badgeError"),
    warn: t("log.badgeWarn"),
    info: t("log.badgeInfo"),
    debug: t("log.badgeDebug"),
    trace: t("log.badgeDebug"),
  };

  const listRef = useRef<HTMLUListElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filteredLogs]);

  function handleScroll() {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }

  function handleExport() {
    const lines = filteredLogs.map(
      (e) =>
        `${formatTime(e.timestamp)} [${e.level.toUpperCase()}] [${e.category}] ${e.message}`,
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `naga-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const reversedLogs = [...filteredLogs].reverse();

  return (
    <div className="log-panel">
      <div className="log-panel__toolbar">
        <div className="log-panel__filters">
          {(["all", "error", "warn", "info", "debug"] as const).map((level) => (
            <button
              key={level}
              type="button"
              className={`action-button action-button--small${levelFilter === level ? "" : " action-button--ghost"}`}
              onClick={() => {
                setLevelFilter(level);
              }}
            >
              {levelLabels[level]}
            </button>
          ))}
          <select
            className="log-panel__category-select"
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
            }}
          >
            <option value="all">{t("log.allCategories")}</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>
        <div className="log-panel__actions">
          <input
            type="text"
            className="log-panel__search"
            placeholder={t("common.search")}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
          />
          <button
            type="button"
            className="action-button action-button--small action-button--secondary"
            onClick={handleExport}
          >
            {t("log.export")}
          </button>
          <button
            type="button"
            className="action-button action-button--small action-button--secondary"
            onClick={() => {
              void openLogDirectory();
            }}
          >
            {t("log.folder")}
          </button>
          <button
            type="button"
            className="action-button action-button--small action-button--ghost"
            onClick={clearLogs}
          >
            {t("log.clear")}
          </button>
        </div>
      </div>
      {reversedLogs.length > 0 ? (
        <ul
          className="log-list log-panel__list"
          ref={listRef}
          onScroll={handleScroll}
        >
          {reversedLogs.map((entry) => (
            <li key={entry.id} className={`log-item log-item--${entry.level}`}>
              <time className="log-item__time">{formatTime(entry.timestamp)}</time>
              <span className={`badge ${levelClasses[entry.level] ?? "badge--info"}`}>
                {badgeLabels[entry.level] ?? entry.level}
              </span>
              <span className="log-item__category">{entry.category}</span>
              <span className="log-item__message">{entry.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel__muted" style={{ padding: "8px 16px" }}>
          {t("log.empty")}
        </p>
      )}
    </div>
  );
}
