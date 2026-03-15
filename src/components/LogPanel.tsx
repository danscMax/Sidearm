import { useEffect, useRef } from "react";
import type { LogPanelControl } from "../hooks/useLogPanel";
import { openLogDirectory } from "../lib/backend";

export interface LogPanelProps {
  logPanel: LogPanelControl;
}

const levelLabels: Record<string, string> = {
  all: "Все",
  error: "Ошибки",
  warn: "Предупр.",
  info: "Инфо",
  debug: "Отладка",
};

const badgeLabels: Record<string, string> = {
  error: "ошибка",
  warn: "вним.",
  info: "инфо",
  debug: "отлад.",
  trace: "отлад.",
};

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
            <option value="all">Все категории</option>
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
            placeholder="Поиск..."
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
            Экспорт
          </button>
          <button
            type="button"
            className="action-button action-button--small action-button--secondary"
            onClick={() => {
              void openLogDirectory();
            }}
          >
            Папка логов
          </button>
          <button
            type="button"
            className="action-button action-button--small action-button--ghost"
            onClick={clearLogs}
          >
            Очистить
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
          Журнал пока пуст. Запустите перехват, чтобы увидеть события.
        </p>
      )}
    </div>
  );
}
