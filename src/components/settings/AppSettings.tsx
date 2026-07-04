import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../../i18n";
import type { AppConfig, CommandError, Settings } from "../../lib/config";
import {
  acceleratorKeyFromCode,
  serializeAccelerator,
} from "../../lib/action-picker-helpers";
import { CaptureRow } from "../action-picker/shared/CaptureRow";
import { Notice, Toggle } from "../shared";
import { useAutostartStatus } from "./useAutostartStatus";

export interface AppSettingsProps {
  activeConfig: AppConfig;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setError: (error: CommandError | null) => void;
}

/** Application tab: autostart (incl. admin sub-toggle), language, clipboard repair. */
export function AppSettings({
  activeConfig,
  updateDraft,
  updateSettings,
  setError,
}: AppSettingsProps) {
  const { t, i18n } = useTranslation();
  const osd = activeConfig.settings;
  const {
    adminAutostart,
    autostartBusy,
    runAtLogon,
    handleRunAtLogonToggle,
    handleRunAsAdminToggle,
  } = useAutostartStatus(updateDraft, setError);
  const [capturingShortcut, setCapturingShortcut] = useState(false);

  // Capture a pressed chord into a Tauri accelerator string, reusing the same
  // key-resolution helpers as the binding ShortcutEditor. Modifier-only presses
  // are ignored so the user can hold Ctrl/Alt before the real key.
  function handleShortcutCapture(event: ReactKeyboardEvent) {
    if (!capturingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    // Use the physical code, not the layout-dependent event.key (which is a
    // Cyrillic letter for Shift+Alt+T on a Russian layout — invalid for Tauri).
    const key = acceleratorKeyFromCode(event.code);
    if (!key) return; // modifier-only or unsupported key — keep waiting.
    updateSettings({
      globalShortcut: serializeAccelerator({
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        win: event.metaKey,
        key,
      }),
    });
    setCapturingShortcut(false);
  }

  return (
    <>
      {/* Autostart */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.autostartHeader")}</span>
        </div>

        <div className="autostart-row">
          <div className="autostart-row__main">
            <div className="autostart-row__title">{t("settings.autostartRunAtLogonTitle")}</div>
            <div className="autostart-row__hint">
              {t("settings.autostartRunAtLogonHint")}
            </div>
          </div>
          <div className="autostart-row__control">
            <Toggle
              checked={runAtLogon}
              onChange={(checked) => void handleRunAtLogonToggle(checked)}
              disabled={autostartBusy}
              ariaLabel={t("settings.autostartRunAtLogonTitle")}
            />
          </div>
        </div>

        {adminAutostart?.supported && (
          <div
            className={`autostart-row autostart-row--sub${runAtLogon ? "" : " autostart-row--disabled"}`}
          >
            <div className="autostart-row__main">
              <div className="autostart-row__title">{t("settings.autostartAdminTitle")}</div>
              <div className="autostart-row__hint">
                {runAtLogon
                  ? t("settings.autostartAdminHintEnabled")
                  : t("settings.autostartAdminHintDisabled")}
              </div>
            </div>
            <div className="autostart-row__control">
              <Toggle
                checked={adminAutostart.enabled}
                onChange={(checked) => void handleRunAsAdminToggle(checked)}
                disabled={autostartBusy || !runAtLogon}
                ariaLabel={t("settings.autostartAdminTitle")}
              />
            </div>
          </div>
        )}

        {adminAutostart?.enabled && adminAutostart.pathMismatch && (
          <Notice variant="error" className="mt-12">
            <p>{t("settings.autostartPathMismatchMsg")}</p>
            <p className="mono-sm">
              {adminAutostart.registeredPath ?? t("settings.autostartPathUnknown")}
            </p>
            <p>{t("settings.autostartCurrentPath")}</p>
            <p className="mono-sm">
              {adminAutostart.currentExe}
            </p>
            <button
              type="button"
              className="action-button action-button--secondary action-button--small mt-8"
              onClick={() => void handleRunAsAdminToggle(true)}
              disabled={autostartBusy}
            >
              {t("settings.autostartReregisterButton")}
            </button>
          </Notice>
        )}
      </section>

      {/* Global shortcut */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.globalShortcutHeader")}</span>
        </div>
        <p className="panel__muted help-sm">{t("settings.globalShortcutHelp")}</p>
        <div onKeyDown={handleShortcutCapture}>
          <CaptureRow
            value={osd.globalShortcut ?? ""}
            placeholder={
              capturingShortcut
                ? t("picker.keyCapturing")
                : t("settings.globalShortcutPlaceholder")
            }
            capturing={capturingShortcut}
            onToggle={() => setCapturingShortcut(!capturingShortcut)}
            recordLabel={t("picker.record")}
          />
        </div>
      </section>

      {/* Device name */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.deviceNameHeader")}</span>
        </div>
        <p className="panel__muted help-sm">{t("settings.deviceNameHelp")}</p>
        <input
          className="settings-text-input"
          type="text"
          value={osd.deviceName ?? ""}
          placeholder={t("settings.deviceNamePlaceholder")}
          onChange={(e) => {
            const value = e.target.value;
            updateSettings({ deviceName: value.trim() ? value : undefined });
          }}
          aria-label={t("settings.deviceNameHeader")}
        />
      </section>

      {/* Language selector */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.languageHeader")}</span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            aria-pressed={i18n.language === "ru"}
            className={`action-button action-button--small${i18n.language === "ru" ? " action-button--active" : " action-button--ghost"}`}
            onClick={() => changeLanguage("ru")}
          >
            Русский
          </button>
          <button
            type="button"
            aria-pressed={i18n.language === "en"}
            className={`action-button action-button--small${i18n.language === "en" ? " action-button--active" : " action-button--ghost"}`}
            onClick={() => changeLanguage("en")}
          >
            English
          </button>
        </div>
      </section>

      {/* Clipboard repair (OSC 52 mojibake workaround) */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.repairClipboardHeader")}</span>
          <label className="settings-section__master">
            <span className="settings-section__master-label">{t("settings.sectionEnableLabel")}</span>
            <Toggle
              checked={osd.repairClipboardOnCopy ?? false}
              onChange={(checked) => updateSettings({ repairClipboardOnCopy: checked })}
              ariaLabel={t("settings.repairClipboardHeader")}
            />
          </label>
        </div>
        <p className="panel__muted help-sm">{t("settings.repairClipboardHelp")}</p>
      </section>

      {/* Onboarding re-run */}
      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("settings.onboardingHeader")}</span>
        </div>
        <p className="panel__muted help-sm">{t("settings.onboardingHelp")}</p>
        <div className="settings-actions">
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => {
              updateDraft((c) => ({
                ...c,
                settings: { ...c.settings, onboardingCompleted: false },
              }));
            }}
          >
            {t("settings.rerunOnboarding")}
          </button>
        </div>
      </section>
    </>
  );
}
