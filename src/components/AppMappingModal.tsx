import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AppMapping, Profile } from "../lib/config";
import { clampPriority } from "../lib/helpers";
import { ChipEditor } from "./ChipEditor";
import { RunningProcessPicker } from "./RunningProcessPicker";
import { CloseButton, ModalFooter, ModalShell, Toggle } from "./shared";
import { ExeIcon } from "./ExeIcon";
import { ExeMatchField } from "./ExeMatchField";

interface AppMappingModalProps {
  /** "create" holds a local draft and commits via `onCreate`; "edit" autosaves
   *  every change through `onChange`. */
  mode: "create" | "edit";
  /** The mapping being edited (edit) or the working draft (create). */
  value: AppMapping;
  /** Report a changed mapping. Edit mode persists; create mode updates the draft. */
  onChange: (next: AppMapping) => void;
  /** Profiles offered in the profile selector. */
  profiles: Profile[];
  onClose: () => void;
  /** Edit mode: human-readable current profile name for the header. */
  profileName?: string;
  /** Edit mode: delete this rule. */
  onDelete?: () => void;
  /** Create mode: commit the draft as a new rule. */
  onCreate?: () => void;
  /** Create mode: the active-window capture block (rendered in the body). */
  captureSlot?: ReactNode;
}

/**
 * Unified app-rule card — the single surface for BOTH creating and editing an
 * app→profile mapping. Create mode adds a capture block and a "Create" button
 * over a local draft; edit mode autosaves each field. One form, no second screen.
 */
export function AppMappingModal({
  mode,
  value,
  onChange,
  profiles,
  onClose,
  profileName,
  onDelete,
  onCreate,
  captureSlot,
}: AppMappingModalProps) {
  const { t } = useTranslation();
  const isCreate = mode === "create";
  const containerRef = useRef<HTMLDivElement>(null);
  const exeInputRef = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showProcessPicker, setShowProcessPicker] = useState(false);

  // Auto-focus the first editable field (the exe input) on mount.
  useEffect(() => {
    exeInputRef.current?.focus();
  }, []);

  return (
    <>
      <ModalShell
        onClose={onClose}
        className="rule-modal"
        dialogRef={containerRef}
        ariaLabel={isCreate ? t("newRule.title") : value.exe}
      >
        <CloseButton onClick={onClose} ariaLabel={t("common.close")} />

        {/* Header */}
        {isCreate ? (
          <div className="rule-modal__header">
            <div>
              <span className="rule-modal__title">{t("newRule.title")}</span>
              <p className="rule-modal__subtitle">{t("newRule.subtitle")}</p>
            </div>
          </div>
        ) : (
          <div className="rule-modal__header">
            <ExeIcon exe={value.exe} processPath={value.processPath} className="profiles__app-card-monogram" />
            <div>
              <span className="rule-modal__title">{value.exe}</span>
              <span className="rule-modal__profile-name">
                {t("ruleModal.profileLabel", { name: profileName ?? "" })}
              </span>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="rule-modal__body">
          {!isCreate ? (
            <p className="rule-modal__description">
              {t("ruleModal.description", { name: profileName ?? "" })}
            </p>
          ) : null}

          {/* Exe input + Browse + pick-running */}
          <ExeMatchField
            label={t("ruleModal.exeLabel")}
            exe={value.exe}
            processPath={value.processPath}
            showProcessPath
            placeholder="chrome.exe"
            browseTitle={t("newRule.browseTitle")}
            browseFilter={t("newRule.browseFilter")}
            browseLabel={t("common.browse")}
            inputRef={exeInputRef}
            onPickRunning={() => setShowProcessPicker(true)}
            pickRunningLabel={t("ruleModal.pickRunning")}
            pickRunningTooltip={t("ruleModal.pickRunningTooltip")}
            onEnter={isCreate ? onCreate : undefined}
            onChange={(exe, processPath) =>
              onChange({ ...value, exe, processPath: processPath || undefined })
            }
          />

          {/* Capture block (create only) */}
          {isCreate ? captureSlot : null}

          {/* Title filters */}
          <div className="field">
            <span className="field__label">{t("ruleModal.titleLabel")}</span>
            <ChipEditor
              values={value.titleIncludes ?? []}
              onChange={(vals) =>
                onChange({
                  ...value,
                  titleIncludes: vals.length > 0 ? vals : undefined,
                })
              }
              placeholder={t("common.optional")}
              ariaLabel={t("ruleModal.titleLabel")}
            />
            <p className="field__description">{t("ruleModal.titleHelp")}</p>
          </div>

          {/* Toggle + Priority row */}
          <div className="rule-modal__inline-row">
            <div className="rule-modal__inline-field">
              <span className="field__label">{t("common.enabled")}</span>
              <Toggle
                checked={value.enabled}
                onChange={(checked) => onChange({ ...value, enabled: checked })}
                ariaLabel={t("common.enabled")}
              />
            </div>

            <label className="rule-modal__inline-field">
              <span className="field__label">
                {t("ruleModal.priorityLabel")}
                <span className="field__hint" title={t("ruleModal.priorityTooltip")}>
                  ?
                </span>
              </span>
              <input
                type="number"
                min={0}
                max={9999}
                value={value.priority}
                className="profiles__priority-input"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const clamped = clampPriority(v);
                  onChange({ ...value, priority: clamped });
                }}
              />
            </label>
          </div>

          {/* Profile selector */}
          <div className="field">
            <span className="field__label">{t("debug.profile")}</span>
            <select
              value={value.profileId}
              onChange={(e) => {
                const newProfileId = e.target.value;
                if (newProfileId !== value.profileId) {
                  onChange({ ...value, profileId: newProfileId });
                }
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="field__description">
              {isCreate ? t("ruleModal.profileChooseHelp") : t("ruleModal.moveProfileHelp")}
            </p>
          </div>
        </div>

        {/* Footer */}
        <ModalFooter className="rule-modal__footer">
          {isCreate ? (
            <button
              type="button"
              className="action-button action-button--accent"
              disabled={!value.exe.trim()}
              onClick={onCreate}
            >
              {t("common.create")}
            </button>
          ) : (
            <>
              <span className="rule-modal__autosave">{t("ruleModal.autosave")}</span>
              <span className="rule-modal__spacer" />
              {confirmingDelete ? (
                <div className="rule-modal__delete-confirm">
                  {t("ruleModal.deleteConfirm")}
                  <button
                    type="button"
                    className="action-button action-button--small action-button--ghost profiles__delete-btn"
                    onClick={() => {
                      onDelete?.();
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
            </>
          )}
        </ModalFooter>
      </ModalShell>
      {showProcessPicker ? (
        <RunningProcessPicker
          onCancel={() => setShowProcessPicker(false)}
          onPick={(proc) => {
            onChange({
              ...value,
              exe: proc.exe.toLowerCase(),
              processPath: proc.path || undefined,
            });
            setShowProcessPicker(false);
          }}
        />
      ) : null}
    </>
  );
}
