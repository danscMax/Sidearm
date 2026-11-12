import { invoke } from "@tauri-apps/api/core";
import { uiText } from "./ui-text";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  Action,
  AppConfig,
  AppPathsInfo,
  BackupEntry,
  CommandError,
  ImportMode,
  ImportPreview,
  LoadConfigResponse,
  RunningProcessInfo,
  SaveConfigResponse,
  SequenceStep,
} from "./config";
import type {
  MouseBatteryEvent,
  MouseSettings,
  MouseStatusEvent,
  NativeModelInfo,
  OnboardBanks,
  OnboardBinding,
  OnboardReport,
  OnboardTakeoverEvent,
} from "./onboard-mapping";
import type {
  ImportOptions as SynapseImportOptions,
  ImportedConfig as SynapseImportedConfig,
  ParsedSynapseProfiles,
} from "./synapse-import";
import type {
  ActionExecutionEvent,
  ActionExecutionEventName,
  ControlResolutionEventName,
  DebugLogEntry,
  EncodedKeyEvent,
  EncodedKeyEventName,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  RuntimeErrorEventName,
  RuntimeEventName,
  RuntimeStateSummary,
  ThrottleBlockedEvent,
  WindowCaptureResult,
  WindowResolutionEventName,
} from "./runtime";

/** A user-selected executable from {@link pickExecutablePath}. */
export interface ExecutablePick {
  /** Absolute path the user selected. */
  path: string;
  /** Lowercased basename, e.g. "chrome.exe". */
  name: string;
}

/** Open a native picker for an executable file. Returns null if the user
 *  cancels. Centralizes the dialog config + basename extraction shared by the
 *  app-mapping and launch-action editors. */
export async function pickExecutablePath(opts: {
  title: string;
  filterName: string;
  extensions: string[];
}): Promise<ExecutablePick | null> {
  const selected = await open({
    title: opts.title,
    filters: [{ name: opts.filterName, extensions: opts.extensions }],
    multiple: false,
  });
  if (typeof selected !== "string") return null;
  const name = (selected.split(/[/\\]/).pop() ?? selected).toLowerCase();
  return { path: selected, name };
}

/** How often each menu item (by action id) was picked from the popup. */
export async function getMenuUsage(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("get_menu_usage");
}

export interface TextFile {
  /** File name without its extension. */
  name: string;
  text: string;
}

/** Pick a folder and read its .txt / .md files (copied in, never linked).
 *  Null when the user cancels. */
export async function pickTextFolder(title: string): Promise<{ folder: string; files: TextFile[] } | null> {
  const selected = await open({ title, directory: true, multiple: false });
  if (typeof selected !== "string") return null;
  const files = await invoke<TextFile[]>("read_text_folder", { path: selected });
  return { folder: selected.split(/[/\\]/).filter(Boolean).pop() ?? selected, files };
}

export async function loadConfig(): Promise<LoadConfigResponse> {
  return invoke<LoadConfigResponse>("load_config");
}

export async function saveConfig(config: AppConfig): Promise<SaveConfigResponse> {
  return invoke<SaveConfigResponse>("save_config", { config });
}

/**
 * Writes the given thumb bindings into the mouse's onboard memory and asks the
 * mouse to confirm each one. The mouse cannot be read — it answers only with
 * what the previous write stored — so a confirmation is the assignment the
 * hardware is currently producing. Fails when the mouse is not connected;
 * callers treat that as a warning, not a config failure.
 */
export async function verifyOnboardMapping(
  bindings: OnboardBinding[],
): Promise<OnboardReport> {
  return invoke<OnboardReport>("verify_onboard_mapping", { bindings });
}

/**
 * Takes the mouse back from Razer's engine: sets the device to `Normal` mode
 * (the firmware emits the onboard records) and rewrites the config's thumb
 * mapping. Offered as the action on the takeover notification.
 */
export async function restoreOnboardControl(): Promise<void> {
  return invoke<void>("restore_onboard_control");
}

export interface SynapseStatus {
  running: boolean;
  startupRestoreAvailable: boolean;
}

export interface SynapseRecoveryResult {
  startupDisabled: boolean;
  startupError: CommandError | null;
}

export async function getSynapseStatus(): Promise<SynapseStatus> {
  return invoke<SynapseStatus>("get_synapse_status");
}

export async function recoverFromSynapse(disableStartup: boolean, closeSynapse: boolean): Promise<SynapseRecoveryResult> {
  return invoke<SynapseRecoveryResult>("recover_from_synapse", { disableStartup, closeSynapse });
}

export async function restoreSynapseStartup(): Promise<void> {
  return invoke<void>("restore_synapse_startup");
}

/** Name, DPI range and poll rates of a device's mouse model (any connected
 *  one when `deviceId` is absent). */
export async function getNativeModel(deviceId?: string): Promise<NativeModelInfo> {
  return invoke<NativeModelInfo>("get_native_model", { deviceId: deviceId ?? null });
}

/** Every native mouse whose receiver is plugged in now. */
export async function listNativeMice(): Promise<NativeModelInfo[]> {
  return invoke<NativeModelInfo[]>("list_native_mice");
}

/** The onboard banks (stored profiles) of a device's mouse. */
export async function getOnboardBanks(deviceId: string): Promise<OnboardBanks> {
  return invoke<OnboardBanks>("get_onboard_banks", { deviceId });
}

/** Read-only text dump of a connected mouse for a "help verify" issue (~20 s). */
export async function getDeviceReport(detail?: "summary" | "full", deviceId?: string): Promise<string> {
  return invoke<string>("get_device_report", { detail: detail ?? null, deviceId: deviceId ?? null });
}

/** Opens a new GitHub issue for a device report in the browser. */
export async function openDeviceReportIssue(): Promise<void> {
  return invoke<void>("open_device_report_issue");
}

/** Hands the tray and the OSD their texts in the UI language (`backend.*`). */
export async function setNativeTexts(texts: Record<string, string>): Promise<void> {
  return invoke<void>("set_native_texts", { texts });
}

/** Active mouse-path states plus the notices not shown yet (which it takes). */
export async function getMouseStatus(): Promise<MouseStatusEvent[]> {
  return invoke<MouseStatusEvent[]>("get_mouse_status");
}

/** Key buttons send consumer signals (`true`) or `F13`..`F24`; restart the
 *  runtime afterwards so capture follows. */
export async function setKeySignals(consumer: boolean): Promise<void> {
  return invoke<void>("set_key_signals", { consumer });
}

/** Opens Windows Settings → Apps → Startup (to turn off Razer Synapse's autostart). */
export async function openStartupAppsSettings(): Promise<void> {
  return invoke<void>("open_startup_apps_settings");
}

/** Battery, DPI and poll rate as a device's mouse reports them now. */
export async function getMouseSettings(deviceId?: string): Promise<MouseSettings> {
  return invoke<MouseSettings>("get_mouse_settings", { deviceId: deviceId ?? null });
}

/** Stores a DPI (both axes) in the mouse; resolves with the settings read back. */
export async function setMouseDpi(dpi: number, deviceId?: string): Promise<MouseSettings> {
  return invoke<MouseSettings>("set_mouse_dpi", { dpi, deviceId: deviceId ?? null });
}

/** Sets the poll rate (one of the model's `pollRates`); resolves with the settings read back. */
export async function setMousePollRate(hz: number, deviceId?: string): Promise<MouseSettings> {
  return invoke<MouseSettings>("set_mouse_poll_rate", { hz, deviceId: deviceId ?? null });
}

export async function getAppPaths(): Promise<AppPathsInfo> {
  return invoke<AppPathsInfo>("get_app_paths");
}

export async function listBackups(): Promise<BackupEntry[]> {
  return invoke<BackupEntry[]>("list_backups");
}

/** Copy a user-picked photo into app-data/devices; returns the bare file name. */
export async function importDeviceImage(sourcePath: string): Promise<string> {
  return invoke<string>("import_device_image", { sourcePath });
}

/** Read a stored device photo as a data: URL (CSP-safe in every build). */
export async function readDeviceImage(fileName: string): Promise<string> {
  return invoke<string>("read_device_image", { fileName });
}

export async function deleteDeviceImage(fileName: string): Promise<void> {
  return invoke<void>("delete_device_image", { fileName });
}

export async function restoreConfigFromBackup(
  backupPath: string,
): Promise<LoadConfigResponse> {
  return invoke<LoadConfigResponse>("restore_config_from_backup", { backupPath });
}

export async function exportFullConfig(targetPath: string): Promise<string> {
  return invoke<string>("export_full_config", { targetPath });
}

export async function importFullConfigPreview(
  sourcePath: string,
): Promise<ImportPreview> {
  return invoke<ImportPreview>("import_full_config_preview", { sourcePath });
}

export async function importFullConfigApply(
  sourcePath: string,
  mode: ImportMode,
): Promise<SaveConfigResponse> {
  return invoke<SaveConfigResponse>("import_full_config_apply", {
    sourcePath,
    mode,
  });
}

export async function openConfigFolder(): Promise<void> {
  return invoke<void>("open_config_folder");
}

export async function acceptPortableMigration(
  copyFromRoaming: boolean,
): Promise<void> {
  return invoke<void>("accept_portable_migration", {
    copyFromRoaming,
  });
}

export async function parseSynapseSource(
  path: string,
): Promise<ParsedSynapseProfiles> {
  return invoke<ParsedSynapseProfiles>("parse_synapse_source", { path });
}

/** Toggle "live capture" mode: while enabled, captured Naga keys are reported
 * to the UI (encoded_key_received) but NOT resolved/executed. Used by the
 * onboarding hardware test so buttons light up without firing real actions.
 * `checkExtraControls` also maps every optional live control for the check. */
let captureModeCommand = Promise.resolve();
export function setInputCaptureMode(enabled: boolean, checkExtraControls = false): Promise<void> {
  const next = captureModeCommand.then(() => invoke<void>("set_input_capture_mode", { enabled, checkExtraControls }));
  captureModeCommand = next.catch(() => {});
  return next;
}

/** Whether a device's buttons reach Sidearm now (its live map is verified). */
export async function getLiveMapReady(deviceId: string): Promise<boolean> {
  return invoke<boolean>("live_map_ready", { deviceId });
}

/** The connected native mice changed (plugged in or out). */
export function listenNativeMiceChanged(onPayload: (mice: NativeModelInfo[]) => void) {
  return listenEvent("native_mice_changed", onPayload);
}

export async function listRunningProcesses(): Promise<RunningProcessInfo[]> {
  return invoke<RunningProcessInfo[]>("list_running_processes");
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
}

export async function listBundledPresets(): Promise<PresetInfo[]> {
  return invoke<PresetInfo[]>("list_bundled_presets");
}

export async function readBundledPreset(id: string): Promise<unknown> {
  return invoke<unknown>("read_bundled_preset", { id });
}

export async function importSynapseIntoConfig(
  parsed: ParsedSynapseProfiles,
  options: SynapseImportOptions,
  base: AppConfig,
): Promise<SynapseImportedConfig> {
  return invoke<SynapseImportedConfig>("import_synapse_into_config", {
    parsed,
    options,
    base,
  });
}

export async function startRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("start_runtime");
}

export async function stopRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("stop_runtime");
}

export async function reloadRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("reload_runtime");
}

export async function rehookCapture(): Promise<void> {
  return invoke<void>("rehook_capture");
}

export async function getDebugLog(): Promise<DebugLogEntry[]> {
  return invoke<DebugLogEntry[]>("get_debug_log");
}

export async function isRunningAsAdmin(): Promise<boolean> {
  return invoke<boolean>("is_running_as_admin");
}

export interface AdminAutostartStatus {
  enabled: boolean;
  registeredPath: string | null;
  currentExe: string;
  pathMismatch: boolean;
  supported: boolean;
  /** Task exists but its hash pin no longer matches (update) or predates pinning. */
  needsReconfirm: boolean;
}

export async function getAdminAutostartStatus(): Promise<AdminAutostartStatus> {
  return invoke<AdminAutostartStatus>("get_admin_autostart_status");
}

/**
 * Relaunch the current session elevated via ShellExecute "runas" (triggers UAC).
 * On success the current process exits and a new elevated one starts — this
 * promise only resolves/rejects when the relaunch is declined or fails.
 */
export async function relaunchAsAdmin(): Promise<void> {
  return invoke<void>("relaunch_as_admin");
}

/**
 * Enable or disable the Windows Task Scheduler entry that launches Sidearm
 * with administrator privileges at user logon (`RunLevel=Highest`,
 * `Trigger=OnLogon`).  Enabling triggers a UAC prompt — this is the only
 * elevation cost; subsequent system starts launch Sidearm elevated without
 * any further prompt, the canonical Windows pattern (used by PowerToys etc.).
 */
export async function setAdminAutostart(enabled: boolean): Promise<AdminAutostartStatus> {
  return invoke<AdminAutostartStatus>("set_admin_autostart", { enabled });
}

export async function openLogDirectory(): Promise<void> {
  return invoke<void>("open_log_directory");
}

export async function captureActiveWindow(
  delayMs?: number,
): Promise<WindowCaptureResult> {
  return invoke<WindowCaptureResult>("capture_active_window", { delayMs });
}

export async function previewResolution(
  encodedKey: string,
  exe?: string,
  title?: string,
): Promise<ResolvedInputPreview> {
  return invoke<ResolvedInputPreview>("preview_resolution", {
    encodedKey,
    exe,
    title,
  });
}

/**
 * Dry-run simulation of action execution. Resolves the input and summarizes
 * what the action WOULD do, without producing any side effects (no keystrokes,
 * no process launches). Uses `ExecutionMode::DryRun` on the Rust side.
 */
export async function executePreviewAction(
  encodedKey: string,
  exe?: string,
  title?: string,
): Promise<ActionExecutionEvent> {
  return invoke<ActionExecutionEvent>("execute_preview_action", {
    encodedKey,
    exe,
    title,
  });
}

/**
 * Live execution of the resolved action. Actually performs side effects such as
 * sending keystrokes, launching processes, or typing text snippets. Requires
 * the config to be saved (no dirty state) and the action to be live-runnable.
 * Uses `ExecutionMode::Live` on the Rust side.
 */
export async function runPreviewAction(
  encodedKey: string,
  exe?: string,
  title?: string,
): Promise<ActionExecutionEvent> {
  return invoke<ActionExecutionEvent>("run_preview_action", {
    encodedKey,
    exe,
    title,
  });
}

/**
 * Live-test a draft action straight from the picker — no save, no encoder
 * signal. Actually executes it; the caller runs a countdown first so the user
 * can switch to the target window.
 */
export async function liveTestAction(action: Action, profileId?: string): Promise<ActionExecutionEvent> {
  return invoke<ActionExecutionEvent>("live_test_action", { action, profileId: profileId ?? null });
}

export async function getExeIcon(exeName: string, processPath?: string): Promise<string | null> {
  return invoke<string | null>("get_exe_icon", { exeName, processPath: processPath ?? null });
}

// Narrow profile export/import IPC (FIXES P2-2). Single-profile
// `ProfileExportData` transfer shared by the Profiles and Settings views. The
// backend validates the path (absolute + home-scoped + .json) so a compromised
// renderer cannot reach arbitrary files via these commands.
export async function exportProfileFile(path: string, contents: string): Promise<void> {
  return invoke<void>("export_profile", { path, contents });
}

export async function importProfileFile(path: string): Promise<string> {
  return invoke<string>("import_profile", { path });
}

/** Write the snippet library to a `.json` / `.md` / `.txt` file (looser inert-text
 *  whitelist than profile export). Path comes from the native save dialog. */
export async function exportSnippetsFile(path: string, contents: string): Promise<void> {
  return invoke<void>("export_snippets", { path, contents });
}

export async function exportVerificationSession(
  filename: string,
  contents: string,
): Promise<string> {
  return invoke<string>("export_verification_session", { filename, contents });
}

/** Generic Tauri event subscription that forwards `event.payload` to
 *  `onPayload`. The typed `listen*Event` wrappers below delegate to it so the
 *  `listen<T>(name, e => cb(e.payload))` boilerplate lives in one place. */
async function listenEvent<T>(
  eventName: string,
  onPayload: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenRuntimeEvent(
  eventName: RuntimeEventName,
  onPayload: (payload: RuntimeStateSummary) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

export async function listenDebugLogAppendedEvent(
  onPayload: (payload: DebugLogEntry) => void,
): Promise<UnlistenFn> {
  return listenEvent("debug_log_appended", onPayload);
}

/** Fires when a duplicate launch was blocked by the single-instance guard;
 *  the existing window has already been focused backend-side. Payload is unit. */
export async function listenSingleInstanceBlocked(
  onBlocked: () => void,
): Promise<UnlistenFn> {
  return listenEvent("single_instance_blocked", onBlocked);
}

/** Fires when the capture helper detects the mouse sending factory digits
 *  (real press + injected duplicate signature) instead of the configured
 *  keys — the Razer profile is not applied. Payload is unit. */
export async function listenMouseDefaultsSuspected(
  onSuspected: () => void,
): Promise<UnlistenFn> {
  return listenEvent("mouse_defaults_suspected", onSuspected);
}

/** Fires when the backend guard caught Razer's engine holding the mouse (driver
 *  mode or rewritten onboard slots). The guard has already taken the device back;
 *  the event tells the UI so the user sees why and can force a re-apply. */
export async function listenOnboardTakeover(
  onPayload: (payload: OnboardTakeoverEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent("onboard_takeover", onPayload);
}

/** Fires when a mouse-path state changes or a notice is raised (then take it
 *  with `getMouseStatus`). */
export async function listenMouseStatus(
  onPayload: (payload: MouseStatusEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent("mouse_status", onPayload);
}

/** Fires when the guard read a new battery level; `low` marks the one reading
 *  per discharge that crossed into the low range. */
export async function listenMouseBattery(
  onPayload: (payload: MouseBatteryEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent("mouse_battery", onPayload);
}

/** Fires once per app when the foreground window runs elevated and Windows
 *  (UIPI) blocks Sidearm's input there. Not sent while Sidearm is elevated. */
export async function listenElevatedForeground(
  onBlocked: (payload: { exe: string }) => void,
): Promise<UnlistenFn> {
  return listenEvent("elevated_foreground_blocked", onBlocked);
}

/** Fires when a binding's re-trigger was skipped inside its throttle window. */
export async function listenThrottleBlocked(
  onPayload: (payload: ThrottleBlockedEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent("throttle_blocked", onPayload);
}

// Tray switched the active profile (manual override) — sync the UI selection.
export async function listenTrayProfileChanged(
  onProfileId: (profileId: string) => void,
): Promise<UnlistenFn> {
  return listenEvent("tray_profile_changed", onProfileId);
}

// Tray "Create rule for active window" captured a window — open a prefilled rule.
export async function listenQuickRuleStart(
  onCapture: (capture: WindowCaptureResult) => void,
): Promise<UnlistenFn> {
  return listenEvent("quick_rule_start", onCapture);
}

// Tray quick-rule couldn't determine a target window (only Sidearm was in front).
export async function listenQuickRuleFailed(onFailed: () => void): Promise<UnlistenFn> {
  return listenEvent<null>("quick_rule_failed", () => onFailed());
}

export async function listenWindowResolutionEvent(
  eventName: WindowResolutionEventName,
  onPayload: (payload: WindowCaptureResult) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

export async function listenEncodedKeyEvent(
  eventName: EncodedKeyEventName,
  onPayload: (payload: EncodedKeyEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

export async function listenControlResolutionEvent(
  eventName: ControlResolutionEventName,
  onPayload: (payload: ResolvedInputPreview) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

export async function listenActionExecutionEvent(
  eventName: ActionExecutionEventName,
  onPayload: (payload: ActionExecutionEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

export async function listenRuntimeErrorEvent(
  eventName: RuntimeErrorEventName,
  onPayload: (payload: RuntimeErrorEvent) => void,
): Promise<UnlistenFn> {
  return listenEvent(eventName, onPayload);
}

/** config.json was changed outside Sidearm (by hand, a script, a sync); the
 *  running capture already took it, the UI should reload it. */
export async function listenConfigChangedExternally(onChange: () => void): Promise<UnlistenFn> {
  return listenEvent<null>("config_changed_externally", () => onChange());
}

/** Right click → Edit in the popup menu: open this item of this menu. */
export interface MenuEditRequest {
  menuActionId: string;
  itemId: string;
  profileId: string | null;
}

export async function listenMenuEditRequested(onRequest: (request: MenuEditRequest) => void): Promise<UnlistenFn> {
  return listenEvent<MenuEditRequest>("menu_edit_requested", onRequest);
}

/** OS file-drop onto the window. Wraps the raw `tauri://drag-drop` event so the
 *  `@tauri-apps/api/event` import stays confined to this module (the single IPC
 *  home); callers receive just the dropped paths. */
export async function listenDragDrop(
  onDrop: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return listenEvent<{ paths: string[] }>("tauri://drag-drop", (payload) => {
    onDrop(payload.paths ?? []);
  });
}

/* ─────────────────────────────────────────────────────────
   Macro Recording IPC
   ───────────────────────────────────────────────────────── */

export async function startMacroRecording(): Promise<void> {
  return invoke<void>("start_macro_recording");
}

export async function recordKeystroke(key: string): Promise<void> {
  return invoke<void>("record_keystroke", { key });
}

export interface MacroRecording {
  steps: SequenceStep[];
  startedAt: number;
  stoppedAt: number | null;
}

export async function stopMacroRecording(): Promise<MacroRecording> {
  return invoke<MacroRecording>("stop_macro_recording");
}

export function normalizeCommandError(error: unknown): CommandError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    const obj = error as Record<string, unknown>;
    const english = typeof obj.message === "string" ? obj.message : "Command failed.";
    return {
      code: typeof obj.code === "string" ? obj.code : "command_error",
      // A keyed backend error is shown in the UI language (English fallback).
      message:
        typeof obj.key === "string"
          ? uiText({ text: english, key: obj.key, params: obj.params as Record<string, string> | undefined })
          : english,
      details: Array.isArray(obj.details)
        ? obj.details.filter(
            (detail): detail is string => typeof detail === "string",
          )
        : undefined,
    };
  }

  if (typeof error === "string") {
    return {
      code: "command_error",
      message: error,
    };
  }

  return {
    code: "command_error",
    message: "Command failed.",
  };
}
