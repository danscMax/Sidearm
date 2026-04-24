import { startTransition, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; profileId: string } | null>(null);
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        {t("app.name")}
        <strong>{t("app.device")}</strong>
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
          <span className="sidebar__section-label">{t("sidebar.profileHeader")}</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={() => onSwitchMode("settings")}
              title={t("sidebar.settingsTooltip")}
            >
              ⚙
            </button>
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={onCreateProfile}
              title={t("sidebar.addProfileTooltip")}
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
                  <span className="pill-track__active-dot" title={t("sidebar.activeRuntime")} />
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
        title={t("sidebar.runtimeTooltip")}
      >
        <span className={`sidebar__runtime-dot sidebar__runtime-dot--${runtimeStatus === "running" ? "running" : "stopped"}`} />
        <span className="sidebar__runtime-label">
          {runtimeStatus === "running" ? t("sidebar.runtimeActive") : t("sidebar.runtimeStopped")}
        </span>
        <span className="sidebar__runtime-action">
          {runtimeStatus === "running" ? t("sidebar.stop") : t("sidebar.start")}
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
                label: t("workspace.settings.label"),
                onClick: () => {
                  onSwitchMode("settings");
                },
              },
              {
                label: t("common.duplicate"),
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
                    label: t("common.delete"),
                    danger: true as const,
                    onClick: () => {
                      setConfirmModal({
                        title: t("confirm.deleteProfileTitle"),
                        message: t("confirm.deleteProfileMessage", { name: targetProfile.name }),
                        confirmLabel: t("common.delete"),
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
