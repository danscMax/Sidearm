import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppConfig, CommandError } from "../lib/config";
import {
  importSynapseIntoConfig,
  normalizeCommandError,
} from "../lib/backend";
import { toggleInSet } from "../lib/helpers";
import { displayNameForControlId } from "../lib/labels";
import type {
  ImportSummary,
  MergeStrategy,
  ParsedSynapseProfiles,
} from "../lib/synapse-import";
import { ModalFooter, ModalHeader, ModalShell } from "./shared";

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
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("append");

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const selectedCount = selected.size;
  const totalBindings = useMemo(
    () =>
      parsed.profiles
        .filter((p) => selected.has(p.synapseGuid))
        .reduce((n, p) => n + p.bindings.length, 0),
    [parsed.profiles, selected],
  );

  function toggleProfile(guid: string) {
    setSelected((prev) => toggleInSet(prev, guid));
  }

  function toggleExpanded(guid: string) {
    setExpanded((prev) => toggleInSet(prev, guid));
  }

  async function handleSubmit() {
    if (submitting || selectedCount === 0) return;
    setSubmitting(true);
    try {
      const result = await importSynapseIntoConfig(
        parsed,
        {
          selectedProfileGuids: Array.from(selected),
          mergeStrategy,
        },
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
                                {b.action.kind === "unmappable"
                                  ? t("synapseImport.unmappable")
                                  : t(`action.type.${b.action.kind}`)}
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
              <ul>
                {parsed.warnings.map((w, i) => (
                  <li key={i}>
                    <code>[{w.code}]</code> {w.message}
                  </li>
                ))}
              </ul>
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
                  profiles: selectedCount,
                  bindings: totalBindings,
                })}
          </button>
        </ModalFooter>
    </ModalShell>
  );
}

