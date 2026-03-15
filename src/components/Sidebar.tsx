import { startTransition, useState } from "react";
import type { WorkspaceMode } from "../lib/constants";
import { workspaceModeCopy } from "../lib/constants";
import type { AppConfig, Profile } from "../lib/config";
import { deleteProfile, duplicateProfile } from "../lib/config-editing";
import { ContextMenu } from "./ContextMenu";

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
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        Sidearm
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
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={() => onSwitchMode("settings")}
              title="Настройки профилей"
            >
              ⚙
            </button>
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={onCreateProfile}
              title="Добавить профиль"
            >
              +
            </button>
          </div>
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
                  onSwitchMode("settings");
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
                  onSwitchMode("settings");
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
    </aside>
  );
}
