import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, CommandError, Profile } from "../../lib/config";
import type { ConfirmModalRequest } from "../ConfirmModal";
import {
  upsertProfile,
  deleteProfile,
  duplicateProfile,
  createProfile,
  importProfile,
} from "../../lib/config-editing";
import { exportProfileToFile, importProfileFromFile } from "../../lib/profile-transfer";
import { normalizeCommandError } from "../../lib/backend";
import { clampPriority } from "../../lib/helpers";
import { PresetsModal } from "../PresetsModal";
import { Notice, Toggle } from "../shared";
import { CopyIcon, ExportIcon, ImportIcon, TrashIcon } from "../icons";

export interface ProfileSettingsProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  setError: (error: CommandError | null) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
}

/** Profiles tab: current-profile editor + all-profiles list + new/import/presets. */
export function ProfileSettings({
  activeConfig,
  activeProfile,
  effectiveProfileId,
  updateDraft,
  setSelectedProfileId,
  setConfirmModal,
  setError,
  showToast,
}: ProfileSettingsProps) {
  const { t } = useTranslation();
  const [importError, setImportError] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);

  const sortedProfiles = [...activeConfig.profiles].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );

  function handleCreateProfile() {
    const nextConfig = createProfile(activeConfig, t("settings.newProfile"));
    const newProfile = nextConfig.profiles.find(
      (p) => !activeConfig.profiles.some((existing) => existing.id === p.id),
    );
    updateDraft(() => nextConfig);
    if (newProfile) {
      setSelectedProfileId(newProfile.id);
    }
  }

  function handleDuplicate(profileId: string) {
    let newId: string | null = null;
    updateDraft((c) => {
      const result = duplicateProfile(c, profileId);
      newId = result.newProfileId;
      return result.config;
    });
    if (newId) setSelectedProfileId(newId);
  }

  function handleDelete(profile: Profile) {
    setConfirmModal({
      title: t("settings.deleteConfirmTitle"),
      message: t("settings.deleteConfirmMessage", { name: profile.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: () => {
        updateDraft((c) => deleteProfile(c, profile.id));
        setSelectedProfileId(null);
        setConfirmModal(null);
      },
    });
  }

  async function handleExport(profile: Profile) {
    try {
      await exportProfileToFile(
        activeConfig,
        profile.id,
        profile.name,
        t("settings.exportDialogTitle"),
      );
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    }
  }

  async function handleImport() {
    setImportError(null);

    try {
      const result = await importProfileFromFile(t("settings.importDialogTitle"));
      if (result.status === "cancelled") return;
      if (result.status === "invalid") {
        setImportError(t("settings.invalidProfileError"));
        return;
      }

      let newId: string | null = null;
      updateDraft((c) => {
        const updated = importProfile(c, result.data);
        newId = updated.profiles[updated.profiles.length - 1]?.id ?? null;
        return updated;
      });
      if (newId) setSelectedProfileId(newId);
    } catch {
      setImportError(t("settings.readProfileError"));
    }
  }

  return (
    <>
      {/* Active profile editor */}
      {activeProfile ? (
        <section className="settings-section">
          <div className="settings-editor">
            <div className="settings-editor__title">{t("settings.profileTitle", { name: activeProfile.name })}</div>

            <div className="field-row">
              <label className="field">
                <span className="field__label">{t("settings.nameLabel")}</span>
                <input
                  type="text"
                  value={activeProfile.name}
                  onChange={(e) =>
                    updateDraft((c) =>
                      upsertProfile(c, { ...activeProfile, name: e.target.value }),
                    )
                  }
                  onBlur={(e) => {
                    if (!e.target.value.trim()) {
                      updateDraft((c) =>
                        upsertProfile(c, { ...activeProfile, name: t("settings.unnamed") }),
                      );
                      showToast(t("settings.renamedToUnnamed"), "info");
                    }
                  }}
                />
              </label>
              <label className="field field--narrow">
                <span className="field__label">
                  {t("settings.priorityLabel")}
                  <span
                    className="field__hint"
                    title={t("settings.priorityTooltip")}
                  >
                    ?
                  </span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={activeProfile.priority}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const clamped = Number.isFinite(v) ? clampPriority(v) : 0;
                    updateDraft((c) => upsertProfile(c, { ...activeProfile, priority: clamped }));
                  }}
                />
              </label>
            </div>

            <label className="field field--inline">
              <span className="field__label">{t("settings.enabledLabel")}</span>
              <Toggle
                checked={activeProfile.enabled}
                onChange={(checked) =>
                  updateDraft((c) => upsertProfile(c, { ...activeProfile, enabled: checked }))
                }
                ariaLabel={t("settings.enabledLabel")}
              />
            </label>

            <label className="field">
              <span className="field__label">{t("settings.descriptionLabel")}</span>
              <textarea
                rows={2}
                value={activeProfile.description ?? ""}
                placeholder={t("settings.descriptionPlaceholder")}
                onChange={(e) =>
                  updateDraft((c) =>
                    upsertProfile(c, { ...activeProfile, description: e.target.value || undefined }),
                  )
                }
              />
            </label>

            {/* Profile actions row */}
            <div className="settings-actions">
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                onClick={() => handleDuplicate(activeProfile.id)}
              >
                <CopyIcon />
                {t("inspector.copyLabel")}
              </button>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                onClick={() => { void handleExport(activeProfile); }}
              >
                <ExportIcon />
                {t("common.export")}
              </button>
              {sortedProfiles.length > 1 ? (
                <button
                  type="button"
                  className="action-button action-button--small action-button--danger"
                  onClick={() => handleDelete(activeProfile)}
                >
                  <TrashIcon />
                  {t("common.delete")}
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {/* All profiles list */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.allProfilesHeader")}</span>
          <span className="settings-section__count">{sortedProfiles.length}</span>
        </div>
        <div className="settings-profile-list">
          {sortedProfiles.map((profile) => {
            const isActive = profile.id === effectiveProfileId;
            return (
              <div
                key={profile.id}
                className={`settings-profile-card${isActive ? " settings-profile-card--active" : ""}${!profile.enabled ? " settings-profile-card--disabled" : ""}`}
              >
                {/* Real <button> for keyboard accessibility (Tab focus + Enter/Space);
                    action buttons stay siblings to avoid nesting button-in-button. */}
                <button
                  type="button"
                  className="settings-profile-card__info"
                  aria-pressed={isActive}
                  onClick={() => setSelectedProfileId(profile.id)}
                >
                  <span className="settings-profile-card__name">{profile.name}</span>
                  <span className="settings-profile-card__meta">
                    {t("settings.priorityMeta", { priority: profile.priority })}
                    {!profile.enabled ? ` · ${t("settings.disabledMeta")}` : ""}
                  </span>
                </button>
                <div className="settings-profile-card__actions">
                  <button
                    type="button"
                    className="settings-icon-btn"
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(profile.id); }}
                    title={t("inspector.copyLabel")}
                  >
                    <CopyIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-btn"
                    onClick={(e) => { e.stopPropagation(); void handleExport(profile); }}
                    title={t("common.export")}
                  >
                    <ExportIcon size={12} />
                  </button>
                  {sortedProfiles.length > 1 ? (
                    <button
                      type="button"
                      className="settings-icon-btn settings-icon-btn--danger"
                      onClick={(e) => { e.stopPropagation(); handleDelete(profile); }}
                      title={t("common.delete")}
                    >
                      <TrashIcon size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="settings-actions mt-12">
          <button
            type="button"
            className="action-button"
            onClick={handleCreateProfile}
          >
            {t("settings.createProfile")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => { void handleImport(); }}
          >
            <ImportIcon />
            {t("settings.importProfileButton")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => setShowPresets(true)}
          >
            {t("settings.presetsButton")}
          </button>
        </div>
        {importError ? (
          <Notice variant="error" className="mt-8">
            <p>{importError}</p>
          </Notice>
        ) : null}
      </section>

      {showPresets ? (
        <PresetsModal
          onCancel={() => setShowPresets(false)}
          updateDraft={updateDraft}
          setError={setError}
        />
      ) : null}
    </>
  );
}
