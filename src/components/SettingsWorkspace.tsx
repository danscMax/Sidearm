import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../i18n";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppConfig,
  CommandError,
  Profile,
  Settings,
  OsdPosition,
  OsdFontSize,
  OsdAnimation,
} from "../lib/config";
import {
  upsertProfile,
  deleteProfile,
  duplicateProfile,
  createProfile,
  extractProfileForExport,
  importProfile,
} from "../lib/config-editing";
import {
  exportFullConfig,
  importFullConfigApply,
  importFullConfigPreview,
  normalizeCommandError,
  openConfigFolder,
  parseSynapseSource,
  readTextFile,
  writeTextFile,
} from "../lib/backend";
import type { ParsedSynapseProfiles } from "../lib/synapse-import";
import { BackupList } from "./BackupList";
import { PresetsModal } from "./PresetsModal";
import { Toggle } from "./shared";

export interface SettingsWorkspaceProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null) => void;
  refreshConfig: () => void;
  setError: (error: CommandError | null) => void;
  onRequestSynapseImport: (parsed: ParsedSynapseProfiles) => void;
}

export function SettingsWorkspace({
  activeConfig,
  activeProfile,
  effectiveProfileId,
  updateDraft,
  setSelectedProfileId,
  setConfirmModal,
  refreshConfig,
  setError,
  onRequestSynapseImport,
}: SettingsWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [importError, setImportError] = useState<string | null>(null);
  const [synapseLoading, setSynapseLoading] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  const sortedProfiles = [...activeConfig.profiles].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );

  const osd = activeConfig.settings;

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      updateDraft((c) => ({
        ...c,
        settings: { ...c.settings, ...patch },
      }));
    },
    [updateDraft],
  );

  // Derive a key that changes whenever OSD visual settings change,
  // causing the preview bubble to replay its animation.
  const previewKey = `${osd.osdPosition}-${osd.osdFontSize}-${osd.osdAnimation}-${osd.osdDurationMs}`;

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
      onConfirm: () => {
        updateDraft((c) => deleteProfile(c, profile.id));
        setSelectedProfileId(null);
        setConfirmModal(null);
      },
    });
  }

  async function handleExport(profile: Profile) {
    const data = extractProfileForExport(activeConfig, profile.id);
    if (!data) return;

    const exportPayload = { ...data, exportedAt: new Date().toISOString() };
    const defaultName = `${profile.name.replace(/[^a-zA-Z0-9\u0430-\u044F\u0410-\u042F_-]/g, "_")}.profile.json`;

    const filePath = await save({
      title: t("settings.exportDialogTitle"),
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof filePath === "string") {
      await writeTextFile(filePath, JSON.stringify(exportPayload, null, 2));
    }
  }

  async function handleImport() {
    setImportError(null);

    const filePath = await open({
      title: t("settings.importDialogTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });

    if (typeof filePath !== "string") return;

    try {
      const raw = await readTextFile(filePath);
      const data = JSON.parse(raw);

      if (!data.profile || !data.bindings || !data.actions) {
        setImportError(t("settings.invalidProfileError"));
        return;
      }

      let newId: string | null = null;
      updateDraft((c) => {
        const result = importProfile(c, data);
        newId = result.profiles[result.profiles.length - 1]?.id ?? null;
        return result;
      });
      if (newId) setSelectedProfileId(newId);
    } catch {
      setImportError(t("settings.readProfileError"));
    }
  }

  // Determine flex alignment for preview based on position
  const posVert = osd.osdPosition.startsWith("top") ? "flex-start" : "flex-end";
  const posHoriz = osd.osdPosition.endsWith("Left") || osd.osdPosition === "topLeft" || osd.osdPosition === "bottomLeft"
    ? "flex-start"
    : "flex-end";

  const previewFontPx = osd.osdFontSize === "small" ? 11 : osd.osdFontSize === "large" ? 14 : 12;
  const previewAnimClass =
    osd.osdAnimation === "fadeIn"
      ? "osd-preview-bubble--fade"
      : osd.osdAnimation === "none"
        ? "osd-preview-bubble--none"
        : "osd-preview-bubble--slide";

  return (
    <div className="settings-workspace">
      {/* Language selector */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.languageHeader")}</span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className={`action-button action-button--small${i18n.language === "ru" ? "" : " action-button--ghost"}`}
            onClick={() => changeLanguage("ru")}
          >
            Русский
          </button>
          <button
            type="button"
            className={`action-button action-button--small${i18n.language === "en" ? "" : " action-button--ghost"}`}
            onClick={() => changeLanguage("en")}
          >
            English
          </button>
        </div>
      </section>

      {/* OSD notification settings */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.osdHeader")}</span>
          <Toggle
            checked={osd.osdEnabled}
            onChange={(checked) => updateSettings({ osdEnabled: checked })}
          />
        </div>

        <div
          className="osd-settings-grid"
          style={osd.osdEnabled ? undefined : { opacity: 0.4, pointerEvents: "none" }}
        >
          {/* Live preview area */}
          <div
            className="osd-preview-area"
            style={{ justifyContent: posVert, alignItems: posHoriz }}
            title={t("settings.osdPreviewHint")}
          >
            <div
              key={previewKey}
              className={`osd-preview-bubble ${previewAnimClass}`}
              style={{ fontSize: previewFontPx }}
            >
              <span className="osd-preview-bubble__label">Профиль:</span>
              <span className="osd-preview-bubble__name">{activeProfile?.name ?? "Main"}</span>
            </div>
          </div>

          {/* Duration */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdDuration")}</span>
            <div className="osd-settings-row__buttons">
              {([1000, 1500, 2000, 3000, 5000] as const).map((ms) => (
                <button
                  key={ms}
                  type="button"
                  className={`action-button action-button--small${osd.osdDurationMs === ms ? "" : " action-button--ghost"}`}
                  onClick={() => updateSettings({ osdDurationMs: ms })}
                >
                  {ms >= 1000 ? `${ms / 1000}` : ms}
                  {"\u0441"}
                </button>
              ))}
            </div>
          </div>

          {/* Position */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdPosition")}</span>
            <div className="osd-settings-row__buttons">
              {(
                [
                  ["topLeft", t("settings.osdPositionTopLeft")],
                  ["topRight", t("settings.osdPositionTopRight")],
                  ["bottomLeft", t("settings.osdPositionBottomLeft")],
                  ["bottomRight", t("settings.osdPositionBottomRight")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`action-button action-button--small${osd.osdPosition === value ? "" : " action-button--ghost"}`}
                  onClick={() => updateSettings({ osdPosition: value as OsdPosition })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdFontSize")}</span>
            <div className="osd-settings-row__buttons">
              {(
                [
                  ["small", t("settings.osdFontSmall")],
                  ["medium", t("settings.osdFontMedium")],
                  ["large", t("settings.osdFontLarge")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`action-button action-button--small${osd.osdFontSize === value ? "" : " action-button--ghost"}`}
                  onClick={() => updateSettings({ osdFontSize: value as OsdFontSize })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Animation */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdAnimation")}</span>
            <div className="osd-settings-row__buttons">
              {(
                [
                  ["slideIn", t("settings.osdAnimSlideIn")],
                  ["fadeIn", t("settings.osdAnimFadeIn")],
                  ["none", t("settings.osdAnimNone")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`action-button action-button--small${osd.osdAnimation === value ? "" : " action-button--ghost"}`}
                  onClick={() => updateSettings({ osdAnimation: value as OsdAnimation })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Advanced capture tuning */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.captureHeader")}</span>
        </div>
        <p className="panel__muted" style={{ fontSize: "0.78rem", marginBottom: 12 }}>
          {t("settings.modifierStaleGcHelp")}
        </p>
        <div className="osd-settings-row">
          <span className="osd-settings-row__label">
            {t("settings.modifierStaleGcLabel")}
          </span>
          <div className="osd-settings-row__buttons">
            {([1000, 3000, 5000, 10000] as const).map((ms) => {
              const current = osd.modifierStaleGcMs ?? 5000;
              const active = current === ms;
              return (
                <button
                  key={ms}
                  type="button"
                  className={`action-button action-button--small${active ? "" : " action-button--ghost"}`}
                  onClick={() =>
                    updateSettings({
                      modifierStaleGcMs: ms === 5000 ? undefined : ms,
                    })
                  }
                >
                  {t("settings.modifierStaleGcOption", { seconds: ms / 1000 })}
                </button>
              );
            })}
          </div>
        </div>
      </section>

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
                    if (!e.target.value.trim())
                      updateDraft((c) =>
                        upsertProfile(c, { ...activeProfile, name: t("settings.unnamed") }),
                      );
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
                    const clamped = Number.isFinite(v) ? Math.max(0, Math.min(9999, Math.round(v))) : 0;
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
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="5" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="var(--c-surface-alt)"/></svg>
                {t("inspector.copyLabel")}
              </button>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                onClick={() => { void handleExport(activeProfile); }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                {t("common.export")}
              </button>
              {sortedProfiles.length > 1 ? (
                <button
                  type="button"
                  className="action-button action-button--small action-button--danger"
                  onClick={() => handleDelete(activeProfile)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
                onClick={() => setSelectedProfileId(profile.id)}
              >
                <div className="settings-profile-card__info">
                  <span className="settings-profile-card__name">{profile.name}</span>
                  <span className="settings-profile-card__meta">
                    {t("settings.priorityMeta", { priority: profile.priority })}
                    {!profile.enabled ? ` \u00B7 ${t("settings.disabledMeta")}` : ""}
                  </span>
                </div>
                <div className="settings-profile-card__actions">
                  <button
                    type="button"
                    className="settings-icon-btn"
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(profile.id); }}
                    title={t("inspector.copyLabel")}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="5" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
                  </button>
                  <button
                    type="button"
                    className="settings-icon-btn"
                    onClick={(e) => { e.stopPropagation(); void handleExport(profile); }}
                    title={t("common.export")}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                  {sortedProfiles.length > 1 ? (
                    <button
                      type="button"
                      className="settings-icon-btn settings-icon-btn--danger"
                      onClick={(e) => { e.stopPropagation(); handleDelete(profile); }}
                      title={t("common.delete")}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="settings-actions" style={{ marginTop: 12 }}>
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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 10V1M5 4l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
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
          <div className="notice notice--error" style={{ marginTop: 8 }}>
            <p>{importError}</p>
          </div>
        ) : null}
      </section>

      {/* Full config backup */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.backupHeader")}</span>
        </div>
        <p className="panel__muted" style={{ fontSize: "0.78rem", marginBottom: 12 }}>
          {t("settings.backupHelp")}
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              const path = await save({
                title: t("settings.saveConfigTitle"),
                defaultPath: `sidearm-backup-${new Date().toISOString().slice(0, 10)}.sidearm-config.json`,
                filters: [{ name: "Sidearm Config", extensions: ["json"] }],
              });
              if (path) {
                try {
                  await exportFullConfig(path);
                } catch (unknownError) {
                  setError(normalizeCommandError(unknownError));
                }
              }
            }}
          >
            {t("settings.exportConfig")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              const path = await open({
                title: t("settings.loadConfigTitle"),
                filters: [{ name: "Sidearm Config", extensions: ["json"] }],
                multiple: false,
              });
              if (typeof path !== "string") return;
              try {
                const preview = await importFullConfigPreview(path);
                const warningsSummary = preview.warnings.length > 0
                  ? t("settings.importHasWarnings", { count: preview.warnings.length })
                  : "";
                setConfirmModal({
                  title: t("settings.replaceConfigTitle"),
                  message: t("settings.importSummary", {
                    profiles: preview.profileCount,
                    bindings: preview.bindingCount,
                    actions: preview.actionCount,
                    appMappings: preview.appMappingCount,
                    snippets: preview.snippetCount,
                    warnings: warningsSummary,
                  }),
                  confirmLabel: t("settings.replaceConfigConfirm"),
                  onConfirm: async () => {
                    try {
                      await importFullConfigApply(path, "replace");
                      refreshConfig();
                      setImportError(null);
                    } catch (unknownError) {
                      setError(normalizeCommandError(unknownError));
                    }
                  },
                });
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              }
            }}
          >
            {t("settings.importConfig")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              try {
                await openConfigFolder();
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              }
            }}
          >
            {t("settings.openConfigFolder")}
          </button>
          <button
            type="button"
            className="action-button action-button--accent"
            disabled={synapseLoading}
            onClick={async () => {
              const path = await open({
                title: t("synapseImport.pickFileTitle"),
                filters: [
                  {
                    name: "Razer Synapse export",
                    extensions: ["synapse4", "synapse3"],
                  },
                  { name: "All files", extensions: ["*"] },
                ],
                multiple: false,
              });
              if (typeof path !== "string") return;
              setSynapseLoading(true);
              try {
                const parsed = await parseSynapseSource(path);
                onRequestSynapseImport(parsed);
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              } finally {
                setSynapseLoading(false);
              }
            }}
          >
            {synapseLoading ? t("synapseImport.parsing") : t("synapseImport.button")}
          </button>
        </div>
      </section>

      {/* Local backups */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("backup.header")}</span>
        </div>
        <p className="panel__muted" style={{ fontSize: "0.78rem", marginBottom: 12 }}>
          {t("backup.help")}
        </p>
        <BackupList
          onRestored={refreshConfig}
          setError={setError}
          setConfirmModal={(modal) =>
            setConfirmModal(
              modal
                ? {
                    title: modal.title,
                    message: modal.message,
                    confirmLabel: modal.confirmLabel,
                    onConfirm: modal.onConfirm,
                  }
                : null,
            )
          }
        />
      </section>

      {showPresets ? (
        <PresetsModal
          onCancel={() => setShowPresets(false)}
          updateDraft={updateDraft}
          setError={setError}
        />
      ) : null}
    </div>
  );
}
