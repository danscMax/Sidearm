import { startTransition, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceMode } from "../lib/constants";
import { workspaceModeCopy } from "../lib/constants";
import type { AppConfig, Profile } from "../lib/config";
import { deleteProfile, duplicateProfile } from "../lib/config-editing";
import { ContextMenu } from "./ContextMenu";
import { ProfileDropdown } from "./ProfileDropdown";
import { useCssVars } from "../hooks/useCssVars";

const NAV_ICONS: Record<WorkspaceMode, ReactNode> = {
  profiles: (
    <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  debug: (
    <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 8h3l2-5 3 10 2-5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  settings: (
    <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="2" y1="5" x2="14" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="2" y1="11" x2="14" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6" cy="5" r="2.1" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="11" r="2.1" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
};

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
  // Sidebar profile pill-track count via CSSOM (CSP-safe; FIXES P2-3).
  const pillTrackRef = useCssVars<HTMLDivElement>({ "--pill-count": profiles.length });
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
          {NAV_ICONS[mode.value]}
          {t(`workspace.${mode.value}.label`)}
        </button>
      ))}
      <div className="sidebar__sep" />
      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-label">{t("sidebar.profileHeader")}</span>
          <div className="sidebar__section-actions">
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
          <div className="pill-track pill-track--sidebar" ref={pillTrackRef}>
            {(() => {
              const idx = profiles.findIndex((p) => p.id === effectiveProfileId);
              return idx >= 0 ? (
                <div
                  className="pill-track__indicator"
                  ref={(el) => {
                    if (el) el.style.setProperty("--pill-offset", `${idx * 100}%`);
                  }}
                />
              ) : null;
            })()}
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pill-track__pill${p.id === effectiveProfileId ? " pill-track__pill--active" : ""}`}
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
          <ProfileDropdown
            profiles={profiles}
            effectiveProfileId={effectiveProfileId}
            runtimeResolvedProfileName={runtimeResolvedProfileName}
            runtimeStatus={runtimeStatus}
            onSelectProfile={(id) => {
              startTransition(() => onSelectProfile(id));
            }}
            onSwitchMode={onSwitchMode}
            onContextMenu={(x, y, profileId) =>
              setCtxMenu({ x, y, profileId })
            }
          />
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
