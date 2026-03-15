import { useState } from "react";
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
  const [importError, setImportError] = useState<string | null>(null);

  const sortedProfiles = [...activeConfig.profiles].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );

  function handleCreateProfile() {
    const nextConfig = createProfile(activeConfig, "Новый профиль");
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
      title: "Удалить профиль?",
      message: `Профиль «${profile.name}» будет удалён вместе со всеми назначениями и правилами.`,
      confirmLabel: "Удалить",
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
      title: "Экспорт профиля",
      defaultPath: defaultName,
      filters: [{ name: "Профиль", extensions: ["json"] }],
    });

    if (typeof filePath === "string") {
      await writeTextFile(filePath, JSON.stringify(exportPayload, null, 2));
    }
  }

  async function handleImport() {
    setImportError(null);

    const filePath = await open({
      title: "Импорт профиля",
      filters: [{ name: "Профиль", extensions: ["json"] }],
      multiple: false,
    });

    if (typeof filePath !== "string") return;

    try {
      const raw = await readTextFile(filePath);
      const data = JSON.parse(raw);

      if (!data.profile || !data.bindings || !data.actions) {
        setImportError("Файл не содержит данных профиля.");
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
      setImportError("Не удалось прочитать файл профиля.");
    }
  }

  return (
    <div className="settings-workspace">
      {/* Active profile editor */}
      {activeProfile ? (
        <section className="panel panel--accent">
          <h2 className="panel__title">Профиль: {activeProfile.name}</h2>
          <div className="editor-grid">
            <label className="field">
              <span className="field__label">Имя</span>
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
                      upsertProfile(c, { ...activeProfile, name: "Безымянный профиль" }),
                    );
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">
                Приоритет
                <span
                  className="field__hint"
                  title="Чем выше число, тем выше приоритет. При совпадении нескольких правил побеждает профиль с наибольшим приоритетом."
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
              <span className="field__label">Включён</span>
              <Toggle
                checked={activeProfile.enabled}
                onChange={(checked) =>
                  updateDraft((c) => upsertProfile(c, { ...activeProfile, enabled: checked }))
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Описание</span>
              <textarea
                rows={2}
                value={activeProfile.description ?? ""}
                placeholder="Необязательное описание"
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
              Копировать
            </button>
            <button
              type="button"
              className="action-button action-button--secondary action-button--small"
              onClick={() => { void handleExport(activeProfile); }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Экспорт
            </button>
            {sortedProfiles.length > 1 ? (
              <button
                type="button"
                className="action-button action-button--small settings-delete-btn"
                onClick={() => handleDelete(activeProfile)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Удалить
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* All profiles list */}
      <section className="panel">
        <div className="profiles__section-header">
          <span>ВСЕ ПРОФИЛИ</span>
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
                    Приоритет: {profile.priority}
                    {!profile.enabled ? " · Отключён" : ""}
                  </span>
                </div>
                <div className="settings-profile-card__actions">
                  <button
                    type="button"
                    className="action-button action-button--small action-button--ghost"
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(profile.id); }}
                    title="Копировать"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="5" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--small action-button--ghost"
                    onClick={(e) => { e.stopPropagation(); void handleExport(profile); }}
                    title="Экспорт"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                  {sortedProfiles.length > 1 ? (
                    <button
                      type="button"
                      className="action-button action-button--small action-button--ghost settings-delete-btn"
                      onClick={(e) => { e.stopPropagation(); handleDelete(profile); }}
                      title="Удалить"
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
            + Новый профиль
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => { void handleImport(); }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 10V1M5 4l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Импорт профиля
          </button>
        </div>
        {importError ? (
          <div className="notice notice--error" style={{ marginTop: 8 }}>
            <p>{importError}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
