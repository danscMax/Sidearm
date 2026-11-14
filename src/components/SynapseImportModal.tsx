import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppConfig, CommandError } from "../lib/config";
import {
  importSynapseIntoConfig,
  normalizeCommandError,
} from "../lib/backend";
import { toggleInSet } from "../lib/helpers";
import { displayNameForControlId } from "../lib/labels";
import type { TFunction } from "i18next";
import {
  describeParsedAction,
  groupWarnings,
  type ImportSummary,
  type ImportWarning,
  type MergeStrategy,
  type ParsedSynapseProfiles,
} from "../lib/synapse-import";
import { ModalFooter, ModalHeader, ModalShell } from "./shared";

/** Most distinct warnings listed; the rest are counted. */
const WARNINGS_SHOWN = 30;

/** Import warnings: each distinct message once (×N when repeated), its code as the tooltip. */
export function ImportWarningList({ warnings }: { warnings: readonly ImportWarning[] }) {
  const { t } = useTranslation();
  const groups = groupWarnings(warnings);
  return (
    <ul>
      {groups.slice(0, WARNINGS_SHOWN).map((group) => (
        <li key={group.message} title={group.code}>
          {group.message}
          {group.count > 1 ? <span className="panel__muted"> {t("synapseImport.warningRepeat", { count: group.count })}</span> : null}
        </li>
      ))}
      {groups.length > WARNINGS_SHOWN ? (
        <li className="panel__muted">{t("synapseImport.warningsMore", { count: groups.length - WARNINGS_SHOWN })}</li>
      ) : null}
    </ul>
  );
}

/** "Imported: 2 profiles, 5 bindings, …" with each count declined, and what was skipped. */
export function importSummaryMessage(t: TFunction, summary: ImportSummary): string {
  const text = t("synapseImport.summaryToast", {
    profiles: t("synapseImport.profileCount", { count: summary.profilesAdded }),
    bindings: t("synapseImport.bindingCount", { count: summary.bindingsAdded }),
    actions: t("synapseImport.actionCount", { count: summary.actionsAdded }),
    macros: t("synapseImport.macroCount", { count: summary.macrosAdded }),
  });
  return summary.skipped > 0 ? t("synapseImport.summarySkipped", { summary: text, count: summary.skipped }) : text;
}

/** What the merge itself reported (oversized macros, duplicates, …), after the import. */
export function SynapseImportNotesModal({ warnings, onClose }: { warnings: readonly ImportWarning[]; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onClose} className="confirm-modal synapse-import-modal" ariaLabelledby="synapse-import-notes-title">
      <ModalHeader id="synapse-import-notes-title" title={t("synapseImport.notesTitle")} onClose={onClose} closeLabel={t("common.close")} />
      <div className="synapse-import-modal__body synapse-import-warnings">
        <ImportWarningList warnings={warnings} />
      </div>
      <ModalFooter>
        <button type="button" className="action-button action-button--accent" onClick={onClose}>{t("common.close")}</button>
      </ModalFooter>
    </ModalShell>
  );
}

export interface SynapseImportModalProps {
  parsed: ParsedSynapseProfiles;
  activeConfig: AppConfig;
  /** Null while an external reload is pending; changes before React commits it. */
  getConfigRevision?: () => number | null;
  onImported: (next: AppConfig, summary: ImportSummary, warnings: ImportWarning[]) => void;
  onCancel: () => void;
  setError: (error: CommandError | null) => void;
}

export function SynapseImportModal({
  parsed,
  activeConfig,
  getConfigRevision,
  onImported,
  onCancel,
  setError,
}: SynapseImportModalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const latestConfigRef = useRef(activeConfig);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(parsed.profiles.map((p) => p.synapseGuid)),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("append");

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    latestConfigRef.current = activeConfig;
  }, [activeConfig]);

  const selectedCount = selected.size;
  const totalBindings = parsed.profiles
    .filter((p) => selected.has(p.synapseGuid))
    .reduce((n, p) => n + p.bindings.length, 0);

  function toggleProfile(guid: string) {
    setSelected((prev) => toggleInSet(prev, guid));
  }

  function toggleExpanded(guid: string) {
    setExpanded((prev) => toggleInSet(prev, guid));
  }

  async function handleSubmit() {
    if (submitting || selectedCount === 0) return;
    const revision = getConfigRevision?.();
    if (revision === null) {
      setError({ code: "config_changed_on_disk", message: t("synapseImport.configChanged") });
      return;
    }
    setSubmitting(true);
    try {
      const result = await importSynapseIntoConfig(
        parsed,
        {
          selectedProfileGuids: Array.from(selected),
          mergeStrategy,
          nameSuffix: t("profile.importSuffix"),
        },
        activeConfig,
      );
      if (latestConfigRef.current !== activeConfig || getConfigRevision?.() !== revision) {
        setError({ code: "config_changed_on_disk", message: t("synapseImport.configChanged") });
        return;
      }
      onImported(result.config, result.summary, result.warnings);
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      onClose={onCancel}
      className="confirm-modal synapse-import-modal"
      dialogRef={containerRef}
      escapeEnabled={!submitting}
      dismissOnBackdropClick={!submitting}
    >
        <ModalHeader
          title={t("synapseImport.title")}
          subtitle={t("synapseImport.sourceLabel", { path: parsed.sourcePath })}
        />

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
                              <span className="synapse-binding-list__control" title={b.controlId}>
                                {displayNameForControlId(b.controlId)}
                              </span>
                              <span className="synapse-binding-list__layer">
                                {b.layer === "hypershift" ? t("layer.hypershift") : t("layer.standard")}
                              </span>
                              <span className="synapse-binding-list__label">
                                {b.label}
                              </span>
                              <span className="synapse-binding-list__kind">
                                {describeParsedAction(b.action, profile.macros)}
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

          <fieldset className="synapse-import-modal__strategy">
            <legend>{t("synapseImport.strategy.legend")}</legend>
            <label>
              <input
                type="radio"
                name="merge-strategy"
                value="append"
                checked={mergeStrategy === "append"}
                onChange={() => setMergeStrategy("append")}
                disabled={submitting}
              />
              <span>{t("synapseImport.strategy.append")}</span>
              <small className="panel__muted">
                {t("synapseImport.strategy.appendHint")}
              </small>
            </label>
            <label>
              <input
                type="radio"
                name="merge-strategy"
                value="replaceByName"
                checked={mergeStrategy === "replaceByName"}
                onChange={() => setMergeStrategy("replaceByName")}
                disabled={submitting}
              />
              <span>{t("synapseImport.strategy.replaceByName")}</span>
              <small className="panel__muted">
                {t("synapseImport.strategy.replaceByNameHint")}
              </small>
            </label>
          </fieldset>

          {parsed.warnings.length > 0 ? (
            <details className="synapse-import-warnings">
              <summary>
                {t("synapseImport.warningsHeader", {
                  count: parsed.warnings.length,
                })}
              </summary>
              <ImportWarningList warnings={parsed.warnings} />
            </details>
          ) : null}
        </div>

        <ModalFooter>
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
            className="action-button action-button--accent"
            onClick={handleSubmit}
            disabled={submitting || selectedCount === 0}
          >
            {submitting
              ? t("synapseImport.submitting")
              : t("synapseImport.submit", {
                  count: selectedCount,
                  bindings: t("synapseImport.bindingCount", { count: totalBindings }),
                })}
          </button>
        </ModalFooter>
    </ModalShell>
  );
}

