import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../i18n";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
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
  importProfile,
} from "../lib/config-editing";
import { exportProfileToFile, importProfileFromFile } from "../lib/profile-transfer";
import { clampPriority } from "../lib/helpers";
import {
  exportFullConfig,
  getAdminAutostartStatus,
  importFullConfigApply,
  importFullConfigPreview,
  normalizeCommandError,
  openConfigFolder,
  parseSynapseSource,
  setAdminAutostart,
  type AdminAutostartStatus,
} from "../lib/backend";
import type { ParsedSynapseProfiles } from "../lib/synapse-import";
import { BackupList } from "./BackupList";
import { PresetsModal } from "./PresetsModal";
import { Notice, Toggle } from "./shared";
import { PillTrack } from "./PillTrack";
import { CopyIcon, ExportIcon, ImportIcon, TrashIcon } from "./icons";

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
    danger?: boolean;
    onConfirm: () => void;
  } | null) => void;
  refreshConfig: () => void;
  setError: (error: CommandError | null) => void;
  onRequestSynapseImport: (parsed: ParsedSynapseProfiles) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
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
  showToast,
}: SettingsWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [importError, setImportError] = useState<string | null>(null);
  const [synapseLoading, setSynapseLoading] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  // Autostart state: regular (registry/startup folder via tauri-plugin-autostart)
  // and elevated (Task Scheduler with /rl highest).  We query both at mount
  // because the config flag and the OS state can drift (e.g. user disabled
  // autostart via Task Manager → Startup but the config still says enabled).
  const [regularAutostart, setRegularAutostart] = useState<boolean | null>(null);
  const [adminAutostart, setAdminAutostartState] = useState<AdminAutostartStatus | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      isAutostartEnabled().catch(() => false),
      getAdminAutostartStatus().catch(() => null),
    ]).then(([regular, admin]) => {
      if (cancelled) return;
      setRegularAutostart(regular);
      setAdminAutostartState(admin);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Master toggle: is Sidearm set to launch automatically at logon at all?
  const runAtLogon = (regularAutostart ?? false) || (adminAutostart?.enabled ?? false);

  async function setRegularEnabled(enable: boolean) {
    if (enable) {
      await enableAutostart();
      setRegularAutostart(true);
      updateDraft((c) => ({ ...c, settings: { ...c.settings, startWithWindows: true } }));
    } else {
      try {
        await disableAutostart();
      } catch {
        // already disabled; tauri-plugin-autostart raises if state matches.
      }
      setRegularAutostart(false);
      updateDraft((c) => ({ ...c, settings: { ...c.settings, startWithWindows: false } }));
    }
  }

  async function setAdminEnabled(enable: boolean) {
    const next = await setAdminAutostart(enable);
    setAdminAutostartState(next);
    return next;
  }

  /** Master toggle handler: turn ALL logon launchers on or off. */
  async function handleRunAtLogonToggle(enable: boolean) {
    setAutostartBusy(true);
    try {
      if (enable) {
        // Turning ON: default to the regular (non-admin) launcher.  The user
        // can flip the sub-toggle to upgrade to admin afterwards.
        await setRegularEnabled(true);
      } else {
        // Turning OFF: kill both launchers.
        if (adminAutostart?.enabled) {
          await setAdminEnabled(false);
        }
        if (regularAutostart) {
          await setRegularEnabled(false);
        }
      }
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setAutostartBusy(false);
    }
  }

  /** Sub-toggle handler: switch between regular and admin launcher. */
  async function handleRunAsAdminToggle(enable: boolean) {
    setAutostartBusy(true);
    try {
      if (enable) {
        // Switching regular → admin.  Enable admin first (UAC prompt here),
        // then drop the regular entry so only one launcher fires at logon.
        const next = await setAdminEnabled(true);
        if (next.enabled && regularAutostart) {
          await setRegularEnabled(false);
        }
      } else {
        // Switching admin → regular.  Make sure the regular launcher is on
        // before removing the admin one; otherwise we'd be silently turning
        // autostart off entirely.
        if (!regularAutostart) {
          await setRegularEnabled(true);
        }
        await setAdminEnabled(false);
      }
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setAutostartBusy(false);
    }
  }

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
      {/* Autostart */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.autostartHeader")}</span>
        </div>

        <div className="autostart-row">
          <div className="autostart-row__main">
            <div className="autostart-row__title">{t("settings.autostartRunAtLogonTitle")}</div>
            <div className="autostart-row__hint">
              {t("settings.autostartRunAtLogonHint")}
            </div>
          </div>
          <div className="autostart-row__control">
            <Toggle
              checked={runAtLogon}
              onChange={(checked) => void handleRunAtLogonToggle(checked)}
              disabled={autostartBusy}
            />
          </div>
        </div>

        {adminAutostart?.supported && (
          <div
            className={`autostart-row autostart-row--sub${runAtLogon ? "" : " autostart-row--disabled"}`}
          >
            <div className="autostart-row__main">
              <div className="autostart-row__title">{t("settings.autostartAdminTitle")}</div>
              <div className="autostart-row__hint">
                {runAtLogon
                  ? t("settings.autostartAdminHintEnabled")
                  : t("settings.autostartAdminHintDisabled")}
              </div>
            </div>
            <div className="autostart-row__control">
              <Toggle
                checked={adminAutostart.enabled}
                onChange={(checked) => void handleRunAsAdminToggle(checked)}
                disabled={autostartBusy || !runAtLogon}
              />
            </div>
          </div>
        )}

        {adminAutostart?.enabled && adminAutostart.pathMismatch && (
          <Notice variant="error" className="mt-12">
            <p>{t("settings.autostartPathMismatchMsg")}</p>
            <p className="mono-sm">
              {adminAutostart.registeredPath ?? t("settings.autostartPathUnknown")}
            </p>
            <p>{t("settings.autostartCurrentPath")}</p>
            <p className="mono-sm">
              {adminAutostart.currentExe}
            </p>
            <button
              type="button"
              className="action-button mt-8"
              onClick={() => void handleRunAsAdminToggle(true)}
              disabled={autostartBusy}
            >
              {t("settings.autostartReregisterButton")}
            </button>
          </Notice>
        )}
      </section>

      {/* Language selector */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.languageHeader")}</span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            aria-pressed={i18n.language === "ru"}
            className={`action-button action-button--small${i18n.language === "ru" ? "" : " action-button--ghost"}`}
            onClick={() => changeLanguage("ru")}
          >
            Русский
          </button>
          <button
            type="button"
            aria-pressed={i18n.language === "en"}
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
          className={`osd-settings-grid${osd.osdEnabled ? "" : " osd-settings-grid--disabled"}`}
        >
          {/* Live preview area */}
          <div
            className="osd-preview-area"
            data-vert={posVert}
            data-horiz={posHoriz}
            title={t("settings.osdPreviewHint")}
          >
            <div
              key={previewKey}
              className={`osd-preview-bubble ${previewAnimClass}`}
              ref={(el) => {
                if (el) el.style.setProperty("font-size", `${previewFontPx}px`);
              }}
            >
              <span className="osd-preview-bubble__label">{t("settings.osdPreviewProfileLabel")}</span>
              <span className="osd-preview-bubble__name">{activeProfile?.name ?? "Main"}</span>
            </div>
          </div>

          {/* Duration */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdDuration")}</span>
            <PillTrack
              items={[1000, 1500, 2000, 3000, 5000].map((ms) => ({
                key: String(ms),
                label: `${ms / 1000}\u0441`,
              }))}
              active={String(osd.osdDurationMs)}
              onSelect={(k) => updateSettings({ osdDurationMs: Number(k) })}
            />
          </div>

          {/* Position */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdPosition")}</span>
            <PillTrack
              items={[
                { key: "topLeft", label: t("settings.osdPositionTopLeft") },
                { key: "topRight", label: t("settings.osdPositionTopRight") },
                { key: "bottomLeft", label: t("settings.osdPositionBottomLeft") },
                { key: "bottomRight", label: t("settings.osdPositionBottomRight") },
              ]}
              active={osd.osdPosition}
              onSelect={(k) => updateSettings({ osdPosition: k as OsdPosition })}
            />
          </div>

          {/* Font size */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdFontSize")}</span>
            <PillTrack
              items={[
                { key: "small", label: t("settings.osdFontSmall") },
                { key: "medium", label: t("settings.osdFontMedium") },
                { key: "large", label: t("settings.osdFontLarge") },
              ]}
              active={osd.osdFontSize}
              onSelect={(k) => updateSettings({ osdFontSize: k as OsdFontSize })}
            />
          </div>

          {/* Animation */}
          <div className="osd-settings-row">
            <span className="osd-settings-row__label">{t("settings.osdAnimation")}</span>
            <PillTrack
              items={[
                { key: "slideIn", label: t("settings.osdAnimSlideIn") },
                { key: "fadeIn", label: t("settings.osdAnimFadeIn") },
                { key: "none", label: t("settings.osdAnimNone") },
              ]}
              active={osd.osdAnimation}
              onSelect={(k) => updateSettings({ osdAnimation: k as OsdAnimation })}
            />
          </div>
        </div>
      </section>

      {/* Clipboard repair (OSC 52 mojibake workaround) */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.repairClipboardHeader")}</span>
          <Toggle
            checked={osd.repairClipboardOnCopy ?? false}
            onChange={(checked) => updateSettings({ repairClipboardOnCopy: checked })}
          />
        </div>
        <p className="panel__muted help-sm">{t("settings.repairClipboardHelp")}</p>
      </section>

      {/* Advanced capture tuning */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.captureHeader")}</span>
        </div>
        <p className="panel__muted help-sm">
          {t("settings.modifierStaleGcHelp")}
        </p>
        <div className="osd-settings-row">
          <span className="osd-settings-row__label">
            {t("settings.modifierStaleGcLabel")}
          </span>
          <PillTrack
            items={[1000, 3000, 5000, 10000].map((ms) => ({
              key: String(ms),
              label: t("settings.modifierStaleGcOption", { seconds: ms / 1000 }),
            }))}
            active={String(osd.modifierStaleGcMs ?? 5000)}
            onSelect={(k) =>
              updateSettings({ modifierStaleGcMs: Number(k) === 5000 ? undefined : Number(k) })
            }
          />
        </div>
        <p className="panel__muted help-sm-y">
          {t("settings.replayedForceReleaseHelp")}
        </p>
        <div className="osd-settings-row">
          <span className="osd-settings-row__label">
            {t("settings.replayedForceReleaseLabel")}
          </span>
          <PillTrack
            items={[5000, 15000, 30000, 60000].map((ms) => ({
              key: String(ms),
              label: t("settings.replayedForceReleaseOption", { seconds: ms / 1000 }),
            }))}
            active={String(osd.replayedModifierForceReleaseMs ?? 30000)}
            onSelect={(k) =>
              updateSettings({
                replayedModifierForceReleaseMs: Number(k) === 30000 ? undefined : Number(k),
              })
            }
          />
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
                    {!profile.enabled ? ` \u00B7 ${t("settings.disabledMeta")}` : ""}
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

      {/* Full config backup */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.backupHeader")}</span>
        </div>
        <p className="panel__muted help-sm">
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
                  danger: true,
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
          <button
            type="button"
            className="action-button"
            onClick={() => {
              updateDraft((c) => ({
                ...c,
                settings: { ...c.settings, onboardingCompleted: false },
              }));
            }}
          >
            {t("settings.rerunOnboarding")}
          </button>
        </div>
      </section>

      {/* Local backups */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("backup.header")}</span>
        </div>
        <p className="panel__muted help-sm">
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
