import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppConfig, AppMapping } from "../lib/config";
import { deleteAppMapping, upsertAppMapping } from "../lib/config-editing";
import { pickExecutablePath } from "../lib/backend";
import { clampPriority } from "../lib/helpers";
import { ChipEditor } from "./ChipEditor";
import { RunningProcessPicker } from "./RunningProcessPicker";
import { CloseButton, ModalFooter, ModalShell, Toggle } from "./shared";
import { ExeIcon } from "./ExeIcon";

interface AppMappingModalProps {
  mapping: AppMapping;
  profileName: string;
  activeConfig: AppConfig;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  onClose: () => void;
}

export function AppMappingModal({
  mapping,
  profileName,
  activeConfig,
  updateDraft,
  onClose,
}: AppMappingModalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const exeInputRef = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showProcessPicker, setShowProcessPicker] = useState(false);

  // Auto-focus the first editable field (the exe input) on mount
  useEffect(() => {
    exeInputRef.current?.focus();
  }, []);

  return (
    <>
      <ModalShell
        onClose={onClose}
        className="rule-modal"
        dialogRef={containerRef}
        ariaLabel={`${mapping.exe}`}
      >
        <CloseButton onClick={onClose} ariaLabel={t("common.close")} />

        {/* Header */}
        <div className="rule-modal__header">
          <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="profiles__app-card-monogram" />
          <div>
            <span className="rule-modal__title">{mapping.exe}</span>
            <span className="rule-modal__profile-name">{t("ruleModal.profileLabel", { name: profileName })}</span>
          </div>
        </div>

        {/* Body */}
        <div className="rule-modal__body">
          <p className="rule-modal__description">
            {t("ruleModal.description", { name: profileName })}
          </p>

          {/* Exe input + Browse */}
          <div className="field">
            <span className="field__label">{t("ruleModal.exeLabel")}</span>
            <div className="field__row">
              <input
                ref={exeInputRef}
                type="text"
                value={mapping.exe}
                placeholder="chrome.exe"
                onChange={(e) =>
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, exe: e.target.value, processPath: undefined }))
                }
              />
              <button
                type="button"
                className="action-button action-button--small"
                onClick={async () => {
                  const pick = await pickExecutablePath({
                    title: t("newRule.browseTitle"),
                    filterName: t("newRule.browseFilter"),
                    extensions: ["exe", "lnk"],
                  });
                  if (pick) {
                    updateDraft((c) =>
                      upsertAppMapping(c, { ...mapping, exe: pick.name, processPath: pick.path }),
                    );
                  }
                }}
              >
                {t("common.browse")}
              </button>
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => setShowProcessPicker(true)}
                title={t("ruleModal.pickRunningTooltip")}
              >
                {t("ruleModal.pickRunning")}
              </button>
            </div>
            {mapping.processPath ? (
              <p
                className="field__description field__description--mono"
                title={mapping.processPath}
              >
                {mapping.processPath}
              </p>
            ) : null}
          </div>

          {/* Title filters */}
          <div className="field">
            <span className="field__label">{t("ruleModal.titleLabel")}</span>
            <ChipEditor
              values={mapping.titleIncludes ?? []}
              onChange={(vals) =>
                updateDraft((c) =>
                  upsertAppMapping(c, {
                    ...mapping,
                    titleIncludes: vals.length > 0 ? vals : undefined,
                  }),
                )
              }
              placeholder={t("common.optional")}
              ariaLabel={t("ruleModal.titleLabel")}
            />
            <p className="field__description">
              {t("ruleModal.titleHelp")}
            </p>
          </div>

          {/* Toggle + Priority row */}
          <div className="rule-modal__inline-row">
            <label className="rule-modal__inline-field">
              <span className="field__label">{t("common.enabled")}</span>
              <Toggle
                checked={mapping.enabled}
                onChange={(checked) =>
                  updateDraft((c) =>
                    upsertAppMapping(c, { ...mapping, enabled: checked }),
                  )
                }
              />
            </label>

            <label className="rule-modal__inline-field">
              <span className="field__label">
                {t("ruleModal.priorityLabel")}
                <span
                  className="field__hint"
                  title={t("ruleModal.priorityTooltip")}
                >
                  ?
                </span>
              </span>
              <input
                type="number"
                min={0}
                max={9999}
                value={mapping.priority}
                className="profiles__priority-input"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v) ? clampPriority(v) : 0;
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, priority: clamped }));
                }}
              />
            </label>
          </div>

          {/* Move to another profile */}
          <div className="field">
            <span className="field__label">{t("debug.profile")}</span>
            <select
              value={mapping.profileId}
              onChange={(e) => {
                const newProfileId = e.target.value;
                if (newProfileId !== mapping.profileId) {
                  updateDraft((c) =>
                    upsertAppMapping(c, { ...mapping, profileId: newProfileId }),
                  );
                }
              }}
            >
              {activeConfig.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="field__description">
              {t("ruleModal.moveProfileHelp")}
            </p>
          </div>
        </div>

        {/* Footer */}
        <ModalFooter className="rule-modal__footer">
          <span className="rule-modal__autosave">{t("ruleModal.autosave")}</span>
          <span className="rule-modal__spacer" />

          {confirmingDelete ? (
            <div className="rule-modal__delete-confirm">
              {t("ruleModal.deleteConfirm")}
              <button
                type="button"
                className="action-button action-button--small action-button--ghost profiles__delete-btn"
                onClick={() => {
                  updateDraft((c) => deleteAppMapping(c, mapping.id));
                  onClose();
                }}
              >
                {t("common.yes")}
              </button>
              <button
                type="button"
                className="action-button action-button--small action-button--ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                {t("common.no")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="action-button action-button--ghost profiles__delete-btn"
              onClick={() => setConfirmingDelete(true)}
            >
              {t("ruleModal.deleteRule")}
            </button>
          )}
        </ModalFooter>
      </ModalShell>
      {showProcessPicker ? (
        <RunningProcessPicker
          onCancel={() => setShowProcessPicker(false)}
          onPick={(proc) => {
            updateDraft((c) =>
              upsertAppMapping(c, {
                ...mapping,
                exe: proc.exe.toLowerCase(),
                processPath: proc.path || undefined,
              }),
            );
            setShowProcessPicker(false);
          }}
        />
      ) : null}
    </>
  );
}
