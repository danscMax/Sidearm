import { useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../i18n";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig, Profile } from "../lib/config";
import {
  upsertProfile,
  deleteProfile,
  duplicateProfile,
  createProfile,
  extractProfileForExport,
  importProfile,
} from "../lib/config-editing";
import { readTextFile, writeTextFile } from "../lib/backend";
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
}

export function SettingsWorkspace({
  activeConfig,
  activeProfile,
  effectiveProfileId,
  updateDraft,
  setSelectedProfileId,
  setConfirmModal,
}: SettingsWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [importError, setImportError] = useState<string | null>(null);

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
    const defaultName = `${profile.name.replace(/[^a-zA-Z0-9а-яА-Я_-]/g, "_")}.profile.json`;

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

  return (
    <div className="settings-workspace">
      {/* Language selector */}
      <section className="panel">
        <div className="profiles__section-header">
          <span>{t("settings.languageHeader")}</span>
        </div>
        <div className="settings-bottom-actions">
          <select
            value={i18n.language}
            onChange={(e) => {
              changeLanguage(e.target.value);
            }}
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </div>
      </section>

      {/* Active profile editor */}
      {activeProfile ? (
        <section className="panel panel--accent">
          <h2 className="panel__title">{t("settings.profileTitle", { name: activeProfile.name })}</h2>
          <div className="editor-grid">
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
            <label className="field">
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
          </div>

          {/* Profile actions row */}
          <div className="settings-profile-actions">
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
                className="action-button action-button--small settings-delete-btn"
                onClick={() => handleDelete(activeProfile)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                {t("common.delete")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* All profiles list */}
      <section className="panel">
        <div className="profiles__section-header">
          <span>{t("settings.allProfilesHeader")}</span>
          <span className="profiles__section-count">{sortedProfiles.length}</span>
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
                  <strong>{profile.name}</strong>
                  <span className="settings-profile-card__meta">
                    {t("settings.priorityMeta", { priority: profile.priority })}
                    {!profile.enabled ? ` · ${t("settings.disabledMeta")}` : ""}
                  </span>
                </div>
                <div className="settings-profile-card__actions">
                  <button
                    type="button"
                    className="action-button action-button--small action-button--ghost"
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(profile.id); }}
                    title={t("inspector.copyLabel")}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="5" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--small action-button--ghost"
                    onClick={(e) => { e.stopPropagation(); void handleExport(profile); }}
                    title={t("common.export")}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                  {sortedProfiles.length > 1 ? (
                    <button
                      type="button"
                      className="action-button action-button--small action-button--ghost settings-delete-btn"
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
        <div className="settings-bottom-actions">
          <button
            type="button"
            className="action-button action-button--secondary"
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
        </div>
        {importError ? (
          <div className="notice notice--error" style={{ marginTop: 8 }}>
            <p>{importError}</p>
          </div>
        ) : null}
      </section>

      {/* Full config backup */}
      <section className="panel">
        <div className="profiles__section-header">
          <span>{t("settings.backupHeader")}</span>
        </div>
        <p className="panel__muted" style={{ fontSize: "0.8rem", marginBottom: 12 }}>
          {t("settings.backupHelp")}
        </p>
        <div className="settings-bottom-actions">
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              const path = await save({
                title: t("settings.saveConfigTitle"),
                defaultPath: `sidearm-backup-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (path) {
                const json = JSON.stringify(activeConfig, null, 2);
                await writeTextFile(path, json);
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
                filters: [{ name: "JSON", extensions: ["json"] }],
                multiple: false,
              });
              if (typeof path === "string") {
                try {
                  const text = await readTextFile(path);
                  const imported = JSON.parse(text) as AppConfig;
                  if (!imported.profiles || !imported.bindings || !imported.settings) {
                    setImportError(t("settings.invalidConfigError"));
                    return;
                  }
                  setConfirmModal({
                    title: t("settings.replaceConfigTitle"),
                    message: t("settings.replaceConfigMessage"),
                    confirmLabel: t("settings.replaceConfigConfirm"),
                    onConfirm: () => {
                      updateDraft(() => imported);
                      setImportError(null);
                    },
                  });
                } catch {
                  setImportError(t("settings.readConfigError"));
                }
              }
            }}
          >
            {t("settings.importConfig")}
          </button>
        </div>
      </section>
    </div>
  );
}
