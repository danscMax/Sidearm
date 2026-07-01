import { useCallback } from "react";
import type { ConfirmModalRequest } from "./ConfirmModal";
import type { AppConfig, CommandError, Profile, Settings } from "../lib/config";
import type { ParsedSynapseProfiles } from "../lib/synapse-import";
import { SettingsShell } from "./settings/SettingsShell";

export type SettingsDeepLink = {
  tab: "snippets";
  snippetId?: string;
  nonce: number;
};

export interface SettingsWorkspaceProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  refreshConfig: () => Promise<boolean>;
  setError: (error: CommandError | null) => void;
  onRequestSynapseImport: (parsed: ParsedSynapseProfiles) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
  deepLink?: SettingsDeepLink | null;
}

/**
 * Thin wrapper for the Settings page. The actual content is split into
 * per-tab components under `./settings`; this keeps the external prop
 * signature stable for App.tsx and owns the shared `updateSettings` helper.
 */
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
  deepLink,
}: SettingsWorkspaceProps) {
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      updateDraft((c) => ({
        ...c,
        settings: { ...c.settings, ...patch },
      }));
    },
    [updateDraft],
  );

  return (
    <SettingsShell
      activeConfig={activeConfig}
      activeProfile={activeProfile}
      effectiveProfileId={effectiveProfileId}
      updateDraft={updateDraft}
      updateSettings={updateSettings}
      setSelectedProfileId={setSelectedProfileId}
      setConfirmModal={setConfirmModal}
      refreshConfig={refreshConfig}
      setError={setError}
      onRequestSynapseImport={onRequestSynapseImport}
      showToast={showToast}
      deepLink={deepLink}
    />
  );
}
