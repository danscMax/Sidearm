import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../../i18n";
import { NATIVE_HYPERSHIFT_TRIGGERS, RAZER_NAGA_DEVICE_ID } from "../../lib/config";
import { displayNameForControlId } from "../../lib/labels";
import { usesNagaV3Ring } from "../../lib/onboard-mapping";
import type {
  AppConfig,
  CommandError,
  HypershiftTrigger,
  Settings,
} from "../../lib/config";
import {
  acceleratorKeyFromCode,
  serializeAccelerator,
} from "../../lib/action-picker-helpers";
import { CaptureRow } from "../action-picker/shared/CaptureRow";
import { PillTrack } from "../PillTrack";
import { Notice, SelectField, SettingRow, Toggle } from "../shared";
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
  const nagaV3 = usesNagaV3Ring(activeConfig) && !activeConfig.devices.some((device) => device.id === RAZER_NAGA_DEVICE_ID);
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

        <SettingRow
          title={t("settings.autostartRunAtLogonTitle")}
          hint={t("settings.autostartRunAtLogonHint")}
        >
          <Toggle
            checked={runAtLogon}
            onChange={(checked) => void handleRunAtLogonToggle(checked)}
            disabled={autostartBusy}
            ariaLabel={t("settings.autostartRunAtLogonTitle")}
          />
        </SettingRow>

        {adminAutostart?.supported && (
          <SettingRow
            title={t("settings.autostartAdminTitle")}
            hint={
              runAtLogon
                ? t("settings.autostartAdminHintEnabled")
                : t("settings.autostartAdminHintDisabled")
            }
            sub
            disabled={!runAtLogon}
          >
            <Toggle
              checked={adminAutostart.enabled}
              onChange={(checked) => void handleRunAsAdminToggle(checked)}
              disabled={autostartBusy || !runAtLogon}
              ariaLabel={t("settings.autostartAdminTitle")}
            />
          </SettingRow>
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

        {adminAutostart?.enabled && !adminAutostart.pathMismatch && adminAutostart.needsReconfirm && (
          <Notice variant="warning" className="mt-12">
            <p>{t("settings.autostartReconfirmMsg")}</p>
            <button
              type="button"
              className="action-button action-button--secondary action-button--small mt-8"
              onClick={() => void handleRunAsAdminToggle(true)}
              disabled={autostartBusy}
            >
              {t("settings.autostartReconfirmButton")}
            </button>
          </Notice>
        )}
      </section>

      <section className="settings-section">
        <SettingRow title={t("settings.globalShortcutHeader")} hint={t("settings.globalShortcutHelp")}>
          <div onKeyDown={handleShortcutCapture}>
            <CaptureRow
              ariaLabel={t("settings.globalShortcutHeader")}
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
        </SettingRow>

        <SettingRow title={t("settings.deviceNameHeader")} hint={t("settings.deviceNameHelp")}>
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
        </SettingRow>

        <SettingRow title={t("settings.languageHeader")}>
          <PillTrack
            items={[
              { key: "ru", label: "Русский" },
              { key: "en", label: "English" },
            ]}
            active={i18n.language === "en" ? "en" : "ru"}
            onSelect={(lang) => changeLanguage(lang)}
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <SettingRow title={t("settings.hypershiftHeader")} hint={t(nagaV3 ? "settings.hypershiftV3Help" : "settings.hypershiftHelp")}>
          {nagaV3 ? <span>{t("control.name.v3Ring")}</span> : <SelectField<HypershiftTrigger>
            ariaLabel={t("settings.hypershiftTriggerLabel")}
            value={osd.hypershiftTrigger ?? "mouse_right"}
            options={[
              ...NATIVE_HYPERSHIFT_TRIGGERS.map((value) => ({ value, label: displayNameForControlId(value) })),
              { value: "none", label: t("settings.hypershiftOff") },
            ]}
            onChange={(trigger) => updateSettings({ hypershiftTrigger: trigger })}
          />}
        </SettingRow>

        {/* Clipboard repair (OSC 52 mojibake workaround) */}
        <SettingRow title={t("settings.repairClipboardHeader")} hint={t("settings.repairClipboardHelp")}>
          <Toggle
            checked={osd.repairClipboardOnCopy ?? false}
            onChange={(checked) => updateSettings({ repairClipboardOnCopy: checked })}
            ariaLabel={t("settings.repairClipboardHeader")}
          />
        </SettingRow>

        <SettingRow title={t("settings.versionTitle")} hint={t("settings.versionHint")}>
          <strong>v{__APP_VERSION__}</strong>
        </SettingRow>

        <SettingRow title={t("settings.onboardingHeader")} hint={t("settings.onboardingHelp")}>
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            onClick={() => {
              updateDraft((c) => ({
                ...c,
                settings: { ...c.settings, onboardingCompleted: false },
              }));
            }}
          >
            {t("settings.rerunOnboarding")}
          </button>
        </SettingRow>
      </section>
    </>
  );
}
