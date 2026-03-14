import { startTransition, useState } from "react";
import type { WorkspaceMode } from "../lib/constants";
import { workspaceModeCopy } from "../lib/constants";
import type { AppConfig, Profile } from "../lib/config";
import { deleteProfile, duplicateProfile, upsertProfile } from "../lib/config-editing";
import { ContextMenu } from "./ContextMenu";
import { Toggle } from "./shared";

export function Sidebar({
  workspaceMode,
  onSwitchMode,
  profiles,
  effectiveProfileId,
  runtimeResolvedProfileName,
  onSelectProfile,
  onCreateProfile,
  onToggleRuntime,
  runtimeStatus,
  updateDraft,
  setSelectedProfileId,
  setConfirmModal,
}: {
  workspaceMode: WorkspaceMode;
  onSwitchMode: (mode: WorkspaceMode) => void;
  profiles: Profile[];
  effectiveProfileId: string | null;
  runtimeResolvedProfileName: string | null;
  onSelectProfile: (id: string) => void;
  onCreateProfile: () => void;
  onToggleRuntime: () => void;
  runtimeStatus: "running" | "stopped" | string;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; profileId: string } | null>(null);
  const [settingsProfileId, setSettingsProfileId] = useState<string | null>(null);
  const settingsProfile = settingsProfileId
    ? profiles.find((p) => p.id === settingsProfileId) ?? null
    : null;
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        Naga Studio
        <strong>Razer Naga V2 HyperSpeed</strong>
      </div>
      {workspaceModeCopy.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={`nav-item${workspaceMode === mode.value ? " nav-item--active" : ""}`}
          onClick={() => { onSwitchMode(mode.value); }}
        >
          {mode.label}
        </button>
      ))}
      <div className="sidebar__sep" />
      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-label">ПРОФИЛЬ</span>
          <button
            type="button"
            className="sidebar__add-profile-btn"
            onClick={onCreateProfile}
            title="Добавить профиль"
          >
            +
          </button>
        </div>
        {profiles.length <= 3 ? (
          <div
            className="pill-track pill-track--sidebar"
            style={{ "--pill-count": profiles.length } as React.CSSProperties}
          >
            {(() => {
              const idx = profiles.findIndex((p) => p.id === effectiveProfileId);
              return idx >= 0 ? (
                <div
                  className="pill-track__indicator"
                  style={{ transform: `translateX(${idx * 100}%)` }}
                />
              ) : null;
            })()}
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pill-track__pill${p.id === effectiveProfileId ? " pill-track__pill--active" : ""}`}
                style={{ position: "relative" }}
                onClick={() => {
                  startTransition(() => onSelectProfile(p.id));
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setSettingsProfileId(p.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, profileId: p.id });
                }}
              >
                {p.name}
                {runtimeStatus === "running" && runtimeResolvedProfileName === p.name ? (
                  <span className="pill-track__active-dot" title="Активный в runtime" />
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="sidebar__profile-select-row">
            <select
              className="sidebar__profile-select"
              value={effectiveProfileId ?? ""}
              onChange={(event) => {
                startTransition(() => {
                  onSelectProfile(event.target.value);
                });
              }}
              onContextMenu={(e) => {
                if (effectiveProfileId) {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, profileId: effectiveProfileId });
                }
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="sidebar__profile-settings-btn"
              onClick={() => { if (effectiveProfileId) setSettingsProfileId(effectiveProfileId); }}
              title="Настройки профиля"
            >
              ⚙
            </button>
          </div>
        )}
      </div>
      <button
        className={`sidebar__runtime sidebar__runtime--${runtimeStatus === "running" ? "running" : "stopped"}`}
        onClick={onToggleRuntime}
        type="button"
      >
        <span className={`sidebar__runtime-dot sidebar__runtime-dot--${runtimeStatus === "running" ? "running" : "stopped"}`} />
        <span className="sidebar__runtime-label">
          {runtimeStatus === "running" ? "Перехват активен" : "Перехват остановлен"}
        </span>
        <span className="sidebar__runtime-action">
          {runtimeStatus === "running" ? "Стоп" : "Старт"}
        </span>
      </button>
      {ctxMenu ? (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={(() => {
            const targetProfile = profiles.find((p) => p.id === ctxMenu.profileId);
            if (!targetProfile) return [];
            return [
              {
                label: "Настройки",
                onClick: () => {
                  setSettingsProfileId(targetProfile.id);
                },
              },
              {
                label: "Дублировать",
                onClick: () => {
                  let newId: string | null = null;
                  updateDraft((c) => {
                    const result = duplicateProfile(c, targetProfile.id);
                    newId = result.newProfileId;
                    return result.config;
                  });
                  if (newId) {
                    startTransition(() => setSelectedProfileId(newId));
                  }
                },
              },
              null,
              ...(profiles.length > 1
                ? [{
                    label: "Удалить",
                    danger: true as const,
                    onClick: () => {
                      setConfirmModal({
                        title: "Удалить профиль?",
                        message: `Профиль «${targetProfile.name}» будет удалён вместе со всеми назначениями и правилами.`,
                        confirmLabel: "Удалить",
                        onConfirm: () => {
                          updateDraft((c) => deleteProfile(c, targetProfile.id));
                          setSelectedProfileId(null);
                          setConfirmModal(null);
                        },
                      });
                    },
                  }]
                : []),
            ];
          })()}
        />
      ) : null}
      {settingsProfile ? (
        <div className="modal-backdrop" onClick={() => setSettingsProfileId(null)}>
          <div
            className="rule-modal rule-modal--compact"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Escape") setSettingsProfileId(null); }}
          >
            <div className="rule-modal__header">
              <span className="rule-modal__title">Настройки профиля</span>
              <button
                type="button"
                className="rule-modal__close"
                onClick={() => setSettingsProfileId(null)}
                aria-label="Закрыть"
              >
                &times;
              </button>
            </div>
            <div className="rule-modal__body">
              <label className="field">
                <span className="field__label">Имя</span>
                <input
                  type="text"
                  value={settingsProfile.name}
                  onChange={(e) =>
                    updateDraft((c) =>
                      upsertProfile(c, { ...settingsProfile, name: e.target.value }),
                    )
                  }
                  onBlur={(e) => {
                    if (!e.target.value.trim())
                      updateDraft((c) =>
                        upsertProfile(c, { ...settingsProfile, name: "Безымянный профиль" }),
                      );
                  }}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  Приоритет
                  <span className="field__hint" title="Чем выше число, тем выше приоритет. При совпадении нескольких правил побеждает профиль с наибольшим приоритетом.">?</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={settingsProfile.priority}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const clamped = Number.isFinite(v)
                      ? Math.max(0, Math.min(9999, Math.round(v)))
                      : 0;
                    updateDraft((c) =>
                      upsertProfile(c, { ...settingsProfile, priority: clamped }),
                    );
                  }}
                />
              </label>
              <label className="field field--inline">
                <span className="field__label">Включён</span>
                <Toggle
                  checked={settingsProfile.enabled}
                  onChange={(checked) =>
                    updateDraft((c) =>
                      upsertProfile(c, { ...settingsProfile, enabled: checked }),
                    )
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">Описание</span>
                <textarea
                  rows={2}
                  value={settingsProfile.description ?? ""}
                  placeholder="Необязательное описание профиля"
                  onChange={(e) =>
                    updateDraft((c) =>
                      upsertProfile(c, { ...settingsProfile, description: e.target.value || undefined }),
                    )
                  }
                />
              </label>
            </div>
            <div className="rule-modal__footer">
              <span className="rule-modal__autosave">Изменения сохраняются автоматически</span>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
