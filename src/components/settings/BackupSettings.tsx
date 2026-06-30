import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { CommandError } from "../../lib/config";
import type { ConfirmModalRequest } from "../ConfirmModal";
import {
  exportFullConfig,
  importFullConfigApply,
  importFullConfigPreview,
  normalizeCommandError,
  openConfigFolder,
  parseSynapseSource,
} from "../../lib/backend";
import type { ParsedSynapseProfiles } from "../../lib/synapse-import";
import { BackupList } from "../BackupList";

export interface BackupSettingsProps {
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  refreshConfig: () => void;
  setError: (error: CommandError | null) => void;
  onRequestSynapseImport: (parsed: ParsedSynapseProfiles) => void;
}

/** Backups tab: full-config export/import, config folder, Synapse import,
 *  and the local rolling/snapshot backup list. */
export function BackupSettings({
  setConfirmModal,
  refreshConfig,
  setError,
  onRequestSynapseImport,
}: BackupSettingsProps) {
  const { t } = useTranslation();
  const [synapseLoading, setSynapseLoading] = useState(false);

  return (
    <>
      {/* Full config backup */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.backupHeader")}</span>
        </div>
        <p className="panel__muted help-sm">
          {t("settings.backupHelp")}
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              const path = await save({
                title: t("settings.saveConfigTitle"),
                defaultPath: `sidearm-backup-${new Date().toISOString().slice(0, 10)}.sidearm-config.json`,
                filters: [{ name: "Sidearm Config", extensions: ["json"] }],
              });
              if (path) {
                try {
                  await exportFullConfig(path);
                } catch (unknownError) {
                  setError(normalizeCommandError(unknownError));
                }
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
                filters: [{ name: "Sidearm Config", extensions: ["json"] }],
                multiple: false,
              });
              if (typeof path !== "string") return;
              try {
                const preview = await importFullConfigPreview(path);
                const warningsSummary = preview.warnings.length > 0
                  ? t("settings.importHasWarnings", { count: preview.warnings.length })
                  : "";
                setConfirmModal({
                  title: t("settings.replaceConfigTitle"),
                  message: t("settings.importSummary", {
                    profiles: preview.profileCount,
                    bindings: preview.bindingCount,
                    actions: preview.actionCount,
                    appMappings: preview.appMappingCount,
                    snippets: preview.snippetCount,
                    warnings: warningsSummary,
                  }),
                  confirmLabel: t("settings.replaceConfigConfirm"),
                  danger: true,
                  onConfirm: async () => {
                    try {
                      await importFullConfigApply(path, "replace");
                      refreshConfig();
                    } catch (unknownError) {
                      setError(normalizeCommandError(unknownError));
                    }
                  },
                });
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              }
            }}
          >
            {t("settings.importConfig")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={async () => {
              try {
                await openConfigFolder();
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              }
            }}
          >
            {t("settings.openConfigFolder")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary"
            disabled={synapseLoading}
            onClick={async () => {
              const path = await open({
                title: t("synapseImport.pickFileTitle"),
                filters: [
                  {
                    name: "Razer Synapse export",
                    extensions: ["synapse4", "synapse3"],
                  },
                  { name: "All files", extensions: ["*"] },
                ],
                multiple: false,
              });
              if (typeof path !== "string") return;
              setSynapseLoading(true);
              try {
                const parsed = await parseSynapseSource(path);
                onRequestSynapseImport(parsed);
              } catch (unknownError) {
                setError(normalizeCommandError(unknownError));
              } finally {
                setSynapseLoading(false);
              }
            }}
          >
            {synapseLoading ? t("synapseImport.parsing") : t("synapseImport.button")}
          </button>
        </div>
      </section>

      {/* Local backups */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("backup.header")}</span>
        </div>
        <p className="panel__muted help-sm">
          {t("backup.help")}
        </p>
        <BackupList
          onRestored={refreshConfig}
          setError={setError}
          setConfirmModal={(modal) =>
            setConfirmModal(
              modal
                ? {
                    title: modal.title,
                    message: modal.message,
                    confirmLabel: modal.confirmLabel,
                    onConfirm: modal.onConfirm,
                  }
                : null,
            )
          }
        />
      </section>
    </>
  );
}
