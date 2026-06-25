import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, CommandError, Profile, Settings } from "../../lib/config";
import type { ConfirmModalRequest } from "../ConfirmModal";
import type { ParsedSynapseProfiles } from "../../lib/synapse-import";
import { AppSettings } from "./AppSettings";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";
import { BackupSettings } from "./BackupSettings";
import { AdvancedSettings } from "./AdvancedSettings";

type SettingsTab = "app" | "notifications" | "profiles" | "backup" | "advanced";

const TABS: ReadonlyArray<{ id: SettingsTab; labelKey: string; icon: ReactNode }> = [
  {
    id: "app",
    labelKey: "settings.tabApp",
    icon: (
      <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "notifications",
    labelKey: "settings.tabNotifications",
    icon: (
      <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 7a4 4 0 018 0c0 3 1.2 4 1.2 4H2.8S4 10 4 7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M6.5 13.5a1.6 1.6 0 003 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "profiles",
    labelKey: "settings.tabProfiles",
    icon: (
      <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3 13a5 5 0 0110 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "backup",
    labelKey: "settings.tabBackup",
    icon: (
      <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="4" rx="5" ry="2.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3 4v8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4M3 8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    id: "advanced",
    labelKey: "settings.tabAdvanced",
    icon: (
      <svg className="nav-item__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="6" cy="4" r="1.6" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="8" r="1.6" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5" cy="12" r="1.6" fill="var(--c-bg)" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
];

export interface SettingsShellProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  refreshConfig: () => void;
  setError: (error: CommandError | null) => void;
  onRequestSynapseImport: (parsed: ParsedSynapseProfiles) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
}

/** Tabbed shell for the Settings page: a vertical tab rail (reusing the
 *  `.nav-item` pattern) + a content area, with local active-tab state. */
export function SettingsShell({
  activeConfig,
  activeProfile,
  effectiveProfileId,
  updateDraft,
  updateSettings,
  setSelectedProfileId,
  setConfirmModal,
  refreshConfig,
  setError,
  onRequestSynapseImport,
  showToast,
}: SettingsShellProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>("app");

  return (
    <div className="settings-shell">
      <nav className="settings-shell__rail" aria-label={t("workspace.settings.label")}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id ? "page" : undefined}
            className={`nav-item${tab === entry.id ? " nav-item--active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.icon}
            <span className="nav-item__label">{t(entry.labelKey)}</span>
          </button>
        ))}
      </nav>

      <div className="settings-shell__content">
        {tab === "app" ? (
          <AppSettings
            activeConfig={activeConfig}
            updateDraft={updateDraft}
            updateSettings={updateSettings}
            setError={setError}
          />
        ) : null}

        {tab === "notifications" ? (
          <NotificationSettings
            activeConfig={activeConfig}
            activeProfile={activeProfile}
            updateSettings={updateSettings}
          />
        ) : null}

        {tab === "profiles" ? (
          <ProfileSettings
            activeConfig={activeConfig}
            activeProfile={activeProfile}
            effectiveProfileId={effectiveProfileId}
            updateDraft={updateDraft}
            setSelectedProfileId={setSelectedProfileId}
            setConfirmModal={setConfirmModal}
            setError={setError}
            showToast={showToast}
          />
        ) : null}

        {tab === "backup" ? (
          <BackupSettings
            updateDraft={updateDraft}
            setConfirmModal={setConfirmModal}
            refreshConfig={refreshConfig}
            setError={setError}
            onRequestSynapseImport={onRequestSynapseImport}
          />
        ) : null}

        {tab === "advanced" ? (
          <AdvancedSettings
            activeConfig={activeConfig}
            updateSettings={updateSettings}
          />
        ) : null}
      </div>
    </div>
  );
}
