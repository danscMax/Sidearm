import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listRunningProcesses, normalizeCommandError } from "../lib/backend";
import type { CommandError, RunningProcessInfo } from "../lib/config";
import { ModalFooter, ModalHeader, ModalShell } from "./shared";
import { useListKeyboard } from "../hooks/useListKeyboard";

export interface RunningProcessPickerProps {
  onPick: (process: RunningProcessInfo) => void;
  onCancel: () => void;
  setError?: (error: CommandError | null) => void;
}

/**
 * Modal listing currently running processes so the user can pick one to
 * populate `appMapping.exe` + `appMapping.processPath` without having to
 * type them manually.
 */
export function RunningProcessPicker({
  onPick,
  onCancel,
  setError,
}: RunningProcessPickerProps) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<RunningProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const loadProcesses = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listRunningProcesses();
      if (!mountedRef.current) return;
      // De-duplicate by (exe + path) because Chromium / Electron-style
      // apps spawn many child processes with the same name.
      const seen = new Set<string>();
      const deduped: RunningProcessInfo[] = [];
      for (const p of list) {
        if (!p.exe) continue;
        const key = `${p.exe.toLowerCase()}|${p.path.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(p);
      }
      deduped.sort((a, b) => a.exe.localeCompare(b.exe, undefined, { sensitivity: "base" }));
      setProcesses(deduped);
    } catch (unknownError) {
      if (mountedRef.current) setError?.(normalizeCommandError(unknownError));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void loadProcesses();
  }, [loadProcesses]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter(
      (p) =>
        p.exe.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q),
    );
  }, [processes, query]);

  const visible = filtered.slice(0, 200);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  const handleKeyDown = useListKeyboard({
    itemCount: visible.length,
    activeIndex,
    setActiveIndex,
    onSelect: (i) => {
      const proc = visible[i];
      if (proc) onPick(proc);
    },
  });

  return (
    <ModalShell
      onClose={onCancel}
      className="confirm-modal process-picker"
      dialogRef={containerRef}
      ariaLabelledby="process-picker-title"
      onKeyDown={handleKeyDown}
    >
        <ModalHeader title={t("processPicker.title")} id="process-picker-title" />
        <input
          ref={inputRef}
          type="search"
          className="process-picker__search"
          placeholder={t("processPicker.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="process-picker__body">
          {loading ? (
            <p className="panel__muted">{t("processPicker.loading")}</p>
          ) : filtered.length === 0 ? (
            <p className="panel__muted">{t("processPicker.empty")}</p>
          ) : (
            <ul className="process-picker__list">
              {visible.map((p, idx) => (
                <li key={`${p.pid}-${p.exe}`}>
                  <button
                    type="button"
                    className={`process-picker__item${idx === activeIndex ? " process-picker__item--active" : ""}`}
                    onClick={() => onPick(p)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    title={p.path || undefined}
                  >
                    <span className="process-picker__exe">{p.exe}</span>
                    <span className="process-picker__pid">{t("processPicker.pid", { pid: p.pid })}</span>
                    {p.path ? (
                      <span className="process-picker__path">{p.path}</span>
                    ) : (
                      <span className="process-picker__path">{t("processPicker.pathUnavailable")}</span>
                    )}
                  </button>
                </li>
              ))}
              {filtered.length > 200 ? (
                <li className="panel__muted process-picker__truncated">
                  {t("processPicker.truncated", { shown: 200, total: filtered.length })}
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <ModalFooter>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => {
              void loadProcesses();
            }}
            disabled={loading}
          >
            {loading ? t("common.processing") : t("processPicker.refresh")}
          </button>
          <button
            type="button"
            className="action-button action-button--ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
        </ModalFooter>
    </ModalShell>
  );
}
