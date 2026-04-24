import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppConfig, CommandError } from "../lib/config";
import {
  importSynapseIntoConfig,
  normalizeCommandError,
} from "../lib/backend";
import type {
  ImportSummary,
  ImportWarning,
  ParsedSynapseProfiles,
} from "../lib/synapse-import";

export interface SynapseImportModalProps {
  parsed: ParsedSynapseProfiles;
  activeConfig: AppConfig;
  onImported: (next: AppConfig, summary: ImportSummary) => void;
  onCancel: () => void;
  setError: (error: CommandError | null) => void;
}

export function SynapseImportModal({
  parsed,
  activeConfig,
  onImported,
  onCancel,
  setError,
}: SynapseImportModalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(parsed.profiles.map((p) => p.synapseGuid)),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    containerRef.current?.focus();
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onCancel, submitting]);

  const selectedCount = selected.size;
  const totalBindings = useMemo(
    () =>
      parsed.profiles
        .filter((p) => selected.has(p.synapseGuid))
        .reduce((n, p) => n + p.bindings.length, 0),
    [parsed.profiles, selected],
  );

  function toggleProfile(guid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  function toggleExpanded(guid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  async function handleSubmit() {
    if (submitting || selectedCount === 0) return;
    setSubmitting(true);
    try {
      const result = await importSynapseIntoConfig(
        parsed,
        { selectedProfileGuids: Array.from(selected) },
        activeConfig,
      );
      onImported(result.config, result.summary);
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={!submitting ? onCancel : undefined}>
      <div
        ref={containerRef}
        className="confirm-modal synapse-import-modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>{t("synapseImport.title")}</h3>
          <p className="panel__muted">
            {t("synapseImport.sourceLabel", { path: parsed.sourcePath })}
          </p>
        </header>

        <div className="synapse-import-modal__body">
          {parsed.profiles.length === 0 ? (
            <p className="panel__muted">{t("synapseImport.noProfiles")}</p>
          ) : (
            <ul className="synapse-profile-list">
              {parsed.profiles.map((profile) => {
                const isSelected = selected.has(profile.synapseGuid);
                const isExpanded = expanded.has(profile.synapseGuid);
                return (
                  <li
                    key={profile.synapseGuid}
                    className="synapse-profile-list__item"
                  >
                    <label className="synapse-profile-list__label">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleProfile(profile.synapseGuid)}
                        disabled={submitting}
                      />
                      <span className="synapse-profile-list__name">
                        {profile.name || t("synapseImport.unnamedProfile")}
                      </span>
                      <span className="synapse-profile-list__meta">
                        {t("synapseImport.profileMeta", {
                          bindings: profile.bindings.length,
                          macros: profile.macros.length,
                        })}
                      </span>
                    </label>
                    <button
                      type="button"
                      className="synapse-profile-list__expander"
                      onClick={() => toggleExpanded(profile.synapseGuid)}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </button>
                    {isExpanded ? (
                      <ul className="synapse-binding-list">
                        {profile.bindings.map((b, i) => {
                          const unmappable = b.action.kind === "unmappable";
                          return (
                            <li
                              key={`${profile.synapseGuid}-${i}`}
                              className={
                                unmappable
                                  ? "synapse-binding-list__item synapse-binding-list__item--skipped"
                                  : "synapse-binding-list__item"
                              }
                              title={
                                unmappable && b.action.kind === "unmappable"
                                  ? b.action.reason
                                  : undefined
                              }
                            >
                              <span className="synapse-binding-list__control">
                                {b.controlId}
                              </span>
                              <span className="synapse-binding-list__layer">
                                {b.layer}
                              </span>
                              <span className="synapse-binding-list__label">
                                {b.label}
                              </span>
                              <span className="synapse-binding-list__kind">
                                {b.action.kind}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {parsed.warnings.length > 0 ? (
            <details className="synapse-import-warnings">
              <summary>
                {t("synapseImport.warningsHeader", {
                  count: parsed.warnings.length,
                })}
              </summary>
              <ul>
                {parsed.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>
                    <code>[{w.code}]</code> {w.message}
                  </li>
                ))}
                {parsed.warnings.length > 20 ? (
                  <li className="panel__muted">
                    {t("synapseImport.warningsMore", {
                      count: parsed.warnings.length - 20,
                    })}
                  </li>
                ) : null}
              </ul>
            </details>
          ) : null}
        </div>

        <footer className="confirm-modal__actions">
          <button
            type="button"
            className="action-button action-button--ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="action-button action-button--primary"
            onClick={handleSubmit}
            disabled={submitting || selectedCount === 0}
          >
            {submitting
              ? t("synapseImport.submitting")
              : t("synapseImport.submit", {
                  profiles: selectedCount,
                  bindings: totalBindings,
                })}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function summarizeImport(
  summary: ImportSummary,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return t("synapseImport.summaryToast", {
    profiles: summary.profilesAdded,
    bindings: summary.bindingsAdded,
    actions: summary.actionsAdded,
    macros: summary.macrosAdded,
  });
}

export function formatWarningsForClipboard(warnings: ImportWarning[]): string {
  return warnings
    .map((w) => `[${w.code}] ${w.message}${w.context ? ` — ${w.context}` : ""}`)
    .join("\n");
}
