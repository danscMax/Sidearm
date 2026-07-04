import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachLogger } from "@tauri-apps/plugin-log";
import { appendToBoundedArray } from "../lib/helpers";

type LogLevelFilter = "all" | "error" | "warn" | "info" | "debug";

interface LogPanelEntry {
  id: number;
  level: "error" | "warn" | "info" | "debug" | "trace";
  category: string;
  message: string;
  timestamp: number;
}

const LOG_BUFFER_LIMIT = 1000;

/** Map plugin LogLevel enum values to string names */
function levelName(level: number): LogPanelEntry["level"] {
  switch (level) {
    case 1:
      return "trace";
    case 2:
      return "debug";
    case 3:
      return "info";
    case 4:
      return "warn";
    case 5:
      return "error";
    default:
      return "info";
  }
}

/**
 * Parse a log message from tauri-plugin-log.
 *
 * The plugin format is: `[HH:MM:SS][LEVEL][rust::module::path] [category] body`
 * We strip all leading `[…]` groups (timestamp, level, module), then look for
 * our own `[category]` bracket prefix in the remaining text.
 */
function extractCategory(message: string): { category: string; body: string } {
  // Strip the plugin-added prefix precisely: [timestamp][LEVEL][module::path].
  // Anchoring on the uppercase LEVEL (the reliable signal) — instead of a generic
  // "2+ bracket groups" run — avoids eating a message body that legitimately
  // starts with its own bracket tokens (e.g. `[warn][retry] connecting`), which
  // the old heuristic mis-parsed. Robust to timestamp-format changes too.
  const stripped = message.replace(
    /^\[[^\]]*\]\[(?:TRACE|DEBUG|INFO|WARN|ERROR)\]\[[^\]]*\]\s*/,
    "",
  );

  // Now check for our [category] prefix
  const match = stripped.match(/^\[([^\]]+)\]\s*(.*)/s);
  if (match) {
    return { category: match[1], body: match[2] };
  }
  return { category: "app", body: stripped };
}

export interface LogPanelControl {
  logs: LogPanelEntry[];
  filteredLogs: LogPanelEntry[];
  categories: string[];
  levelFilter: LogLevelFilter;
  setLevelFilter: (filter: LogLevelFilter) => void;
  categoryFilter: string;
  setCategoryFilter: (category: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  clearLogs: () => void;
  /** Test-only: simulate receiving a log entry */
  _ingestForTest: (entry: { level: number; message: string }) => void;
}

export function useLogPanel(): LogPanelControl {
  const [logs, setLogs] = useState<LogPanelEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const nextIdRef = useRef(1);

  const ingest = useCallback(
    (entry: { level: number; message: string }) => {
      const { category, body } = extractCategory(entry.message);
      const newEntry: LogPanelEntry = {
        id: nextIdRef.current++,
        level: levelName(entry.level),
        category,
        message: body,
        timestamp: Date.now(),
      };
      setLogs((prev) => appendToBoundedArray(prev, newEntry, LOG_BUFFER_LIMIT));
    },
    [],
  );

  useEffect(() => {
    // `cancelled` guards the async attach against the StrictMode double-mount:
    // if cleanup runs before attachLogger resolves, `detach` is still null, so
    // we detach the logger as soon as it arrives instead of leaking it.
    let cancelled = false;
    let detach: (() => void) | null = null;

    void attachLogger(({ level, message }) => {
      ingest({ level, message });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          detach = fn;
        }
      })
      .catch((error) => {
        console.error("Failed to attach logger:", error);
      });

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [ingest]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of logs) {
      set.add(entry.category);
    }
    return [...set].sort();
  }, [logs]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (levelFilter !== "all") {
      result = result.filter((entry) => entry.level === levelFilter);
    }
    if (categoryFilter !== "all") {
      result = result.filter((entry) => entry.category === categoryFilter);
    }
    if (searchQuery) {
      const lower = searchQuery.toLowerCase();
      result = result.filter(
        (entry) =>
          entry.message.toLowerCase().includes(lower) ||
          entry.category.toLowerCase().includes(lower),
      );
    }
    return result;
  }, [logs, levelFilter, categoryFilter, searchQuery]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    logs,
    filteredLogs,
    categories,
    levelFilter,
    setLevelFilter,
    categoryFilter,
    setCategoryFilter,
    searchQuery,
    setSearchQuery,
    clearLogs,
    _ingestForTest: ingest,
  };
}
