import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listRunningProcesses, normalizeCommandError } from "../lib/backend";
import type { CommandError, RunningProcessInfo } from "../lib/config";

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

  useEffect(() => {
    let cancelled = false;
    void listRunningProcesses()
      .then((list) => {
        if (cancelled) return;
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
      })
      .catch((unknownError) => {
        if (cancelled) return;
        setError?.(normalizeCommandError(unknownError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setError]);

  useEffect(() => {
    inputRef.current?.focus();
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter(
      (p) =>
        p.exe.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q),
    );
  }, [processes, query]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={containerRef}
        className="confirm-modal process-picker"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t("processPicker.title")}</h3>
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
              {filtered.slice(0, 200).map((p) => (
                <li key={`${p.pid}-${p.exe}`}>
                  <button
                    type="button"
                    className="process-picker__item"
                    onClick={() => onPick(p)}
                    title={p.path || undefined}
                  >
                    <span className="process-picker__exe">{p.exe}</span>
                    <span className="process-picker__pid">pid {p.pid}</span>
                    {p.path ? (
                      <span className="process-picker__path">{p.path}</span>
                    ) : null}
                  </button>
                </li>
              ))}
              {filtered.length > 200 ? (
                <li className="panel__muted" style={{ padding: "6px 10px" }}>
                  {t("processPicker.truncated", { shown: 200, total: filtered.length })}
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="confirm-modal__actions">
          <button
            type="button"
            className="action-button action-button--ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
