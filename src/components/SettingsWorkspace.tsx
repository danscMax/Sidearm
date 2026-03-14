import type { AppConfig, Profile } from "../lib/config";
import { upsertProfile, deleteProfile, duplicateProfile, createProfile } from "../lib/config-editing";
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
                    title="Дублировать"
                  >
                    ⎘
                  </button>
                  {sortedProfiles.length > 1 ? (
                    <button
                      type="button"
                      className="action-button action-button--small action-button--ghost"
                      onClick={(e) => { e.stopPropagation(); handleDelete(profile); }}
                      title="Удалить"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="profiles__add-card"
          onClick={handleCreateProfile}
        >
          + Новый профиль
        </button>
      </section>
    </div>
  );
}
