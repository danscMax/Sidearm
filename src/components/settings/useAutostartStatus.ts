import { useEffect, useState } from "react";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import type { AppConfig, CommandError } from "../../lib/config";
import {
  getAdminAutostartStatus,
  normalizeCommandError,
  setAdminAutostart,
  type AdminAutostartStatus,
} from "../../lib/backend";

export interface AutostartStatus {
  /** Whether the elevated (Task Scheduler) launcher is supported / its state. */
  adminAutostart: AdminAutostartStatus | null;
  /** A control is in-flight (toggles disabled while true). */
  autostartBusy: boolean;
  /** Master: is Sidearm set to launch at logon at all (regular OR admin)? */
  runAtLogon: boolean;
  /** Master toggle: turn ALL logon launchers on or off. */
  handleRunAtLogonToggle: (enable: boolean) => Promise<void>;
  /** Sub-toggle: switch between regular and admin launcher. */
  handleRunAsAdminToggle: (enable: boolean) => Promise<void>;
}

/**
 * Owns the autostart OS-state probing and the two toggle handlers. Extracted
 * from SettingsWorkspace so only AppSettings carries this concern. Behaviour is
 * unchanged: regular (registry/startup folder via tauri-plugin-autostart) and
 * elevated (Task Scheduler with /rl highest) are queried at mount because the
 * config flag and the OS state can drift.
 */
export function useAutostartStatus(
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void,
  setError: (error: CommandError | null) => void,
): AutostartStatus {
  const [regularAutostart, setRegularAutostart] = useState<boolean | null>(null);
  const [adminAutostart, setAdminAutostartState] = useState<AdminAutostartStatus | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      isAutostartEnabled().catch(() => false),
      getAdminAutostartStatus().catch(() => null),
    ]).then(([regular, admin]) => {
      if (cancelled) return;
      setRegularAutostart(regular);
      setAdminAutostartState(admin);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runAtLogon = (regularAutostart ?? false) || (adminAutostart?.enabled ?? false);

  async function setRegularEnabled(enable: boolean) {
    if (enable) {
      await enableAutostart();
      setRegularAutostart(true);
      updateDraft((c) => ({ ...c, settings: { ...c.settings, startWithWindows: true } }));
    } else {
      try {
        await disableAutostart();
      } catch {
        // already disabled; tauri-plugin-autostart raises if state matches.
      }
      setRegularAutostart(false);
      updateDraft((c) => ({ ...c, settings: { ...c.settings, startWithWindows: false } }));
    }
  }

  async function setAdminEnabled(enable: boolean) {
    const next = await setAdminAutostart(enable);
    setAdminAutostartState(next);
    return next;
  }

  /** Master toggle handler: turn ALL logon launchers on or off. */
  async function handleRunAtLogonToggle(enable: boolean) {
    setAutostartBusy(true);
    try {
      if (enable) {
        // Turning ON: default to the regular (non-admin) launcher.  The user
        // can flip the sub-toggle to upgrade to admin afterwards.
        await setRegularEnabled(true);
      } else {
        // Turning OFF: kill both launchers.
        if (adminAutostart?.enabled) {
          await setAdminEnabled(false);
        }
        if (regularAutostart) {
          await setRegularEnabled(false);
        }
      }
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setAutostartBusy(false);
    }
  }

  /** Sub-toggle handler: switch between regular and admin launcher. */
  async function handleRunAsAdminToggle(enable: boolean) {
    setAutostartBusy(true);
    try {
      if (enable) {
        // Switching regular → admin.  Enable admin first (UAC prompt here),
        // then drop the regular entry so only one launcher fires at logon.
        const next = await setAdminEnabled(true);
        if (next.enabled && regularAutostart) {
          await setRegularEnabled(false);
        }
      } else {
        // Switching admin → regular.  Make sure the regular launcher is on
        // before removing the admin one; otherwise we'd be silently turning
        // autostart off entirely.
        if (!regularAutostart) {
          await setRegularEnabled(true);
        }
        await setAdminEnabled(false);
      }
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setAutostartBusy(false);
    }
  }

  return {
    adminAutostart,
    autostartBusy,
    runAtLogon,
    handleRunAtLogonToggle,
    handleRunAsAdminToggle,
  };
}
