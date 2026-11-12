import { startTransition, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceMode } from "../lib/constants";
import { workspaceModeCopy } from "../lib/constants";
import type { AppConfig, Profile } from "../lib/config";
import { placeSlot, reorderProfiles, slotHasMenu } from "../lib/binding-moves";
import { deleteProfile, duplicateProfile } from "../lib/config-editing";
import { ContextMenu } from "./ContextMenu";
import { SidebarProfiles, type RecognizedApp } from "./SidebarProfiles";
import type { ConfirmModalRequest } from "./ConfirmModal";

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
  runtimeStatus,
  updateDraft,
  setSelectedProfileId,
  setConfirmModal,
  activeConfig,
  selectedDeviceName,
  allRules,
  onEditRule,
  onRuleMenu,
  onAddRule,
  onToggleAllRules,
  recognized,
  showToast,
}: {
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
  workspaceMode: WorkspaceMode;
  onSwitchMode: (mode: WorkspaceMode) => void;
  profiles: Profile[];
  effectiveProfileId: string | null;
  runtimeResolvedProfileName: string | null;
  onSelectProfile: (id: string) => void;
  onCreateProfile: () => void;
  runtimeStatus: "running" | "stopped" | string;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  activeConfig?: AppConfig | null;
  selectedDeviceName?: string;
  /** The all-rules view of the assignments screen. */
  allRules: boolean;
  onEditRule: (mappingId: string) => void;
  onRuleMenu: (mappingId: string, x: number, y: number) => void;
  onAddRule: () => void;
  onToggleAllRules: () => void;
  /** The foreground app the runtime recognized last (null while stopped). */
  recognized: RecognizedApp | null;
}) {
  const { t } = useTranslation();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; profileId: string } | null>(null);
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img
          className="sidebar__logo"
          src="/assets/icon.png"
          alt=""
          aria-hidden="true"
          width={28}
          height={28}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        <div className="sidebar__brand-text">
          <span>
            {t("app.name")} <span className="sidebar__version">v{__APP_VERSION__}</span>
          </span>
          <strong>{selectedDeviceName ?? t("app.deviceFallback")}</strong>
        </div>
      </div>
      {workspaceModeCopy.map((mode) => (
        <button
          key={mode.value}
          type="button"
          aria-current={workspaceMode === mode.value ? "page" : undefined}
          className={`nav-item${workspaceMode === mode.value ? " nav-item--active" : ""}`}
          onClick={() => { onSwitchMode(mode.value); }}
          title={t(`workspace.${mode.value}.label`)}
        >
          {NAV_ICONS[mode.value]}
          <span className="nav-item__label">{t(`workspace.${mode.value}.label`)}</span>
        </button>
      ))}
      {workspaceMode !== "settings" ? (
      <>
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
              aria-label={t("sidebar.settingsTooltip")}
            >
              <span aria-hidden="true">⚙</span>
            </button>
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={onCreateProfile}
              title={t("sidebar.addProfileTooltip")}
              aria-label={t("sidebar.addProfileTooltip")}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
        <SidebarProfiles
          profiles={profiles}
          appMappings={activeConfig?.appMappings ?? []}
          effectiveProfileId={effectiveProfileId}
          runtimeProfileName={runtimeStatus === "running" ? runtimeResolvedProfileName : null}
          allRules={allRules}
          onSelect={onSelectProfile}
          onContextMenu={(x, y, profileId) => setCtxMenu({ x, y, profileId })}
          onOpenSettings={() => onSwitchMode("settings")}
          onEditRule={onEditRule}
          onRuleMenu={onRuleMenu}
          recognized={recognized}
          onAddRule={onAddRule}
          onToggleAllRules={onToggleAllRules}
          onDropBinding={(profileId, from) => {
            if (!activeConfig) return;
            const to = { ...from, profileId };
            const name = profiles.find((p) => p.id === profileId)?.name ?? profileId;
            if (slotHasMenu(activeConfig, from)) { showToast(t("binding.transferMenuBlocked"), "warning"); return; }
            if (placeSlot(activeConfig, from, to, "copy").outcome === "none") return;
            updateDraft((c) => placeSlot(c, from, to, "copy").config);
            showToast(t("assignments.copiedToProfile", { profile: name }), "success");
          }}
          onMoveProfile={(dragged, target) => updateDraft((c) => reorderProfiles(c, dragged, target))}
        />
        {runtimeStatus === "running" && profiles.some((p) => p.name === runtimeResolvedProfileName) ? (
          <p className="sidebar__profile-legend help-caption">
            <span className="pill-track__active-dot sidebar__profile-legend-dot" aria-hidden="true" />
            {t("sidebar.runtimeLegend")}
          </p>
        ) : null}
      </div>
      </>
      ) : null}
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
                        danger: true,
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
