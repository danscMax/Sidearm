import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
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

export async function loadConfig(): Promise<LoadConfigResponse> {
  return invoke<LoadConfigResponse>("load_config");
}

export async function saveConfig(config: AppConfig): Promise<SaveConfigResponse> {
  return invoke<SaveConfigResponse>("save_config", { config });
}

export async function getAppPaths(): Promise<AppPathsInfo> {
  return invoke<AppPathsInfo>("get_app_paths");
}

export async function listBackups(): Promise<BackupEntry[]> {
  return invoke<BackupEntry[]>("list_backups");
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
): Promise<LoadConfigResponse> {
  return invoke<LoadConfigResponse>("accept_portable_migration", {
    copyFromRoaming,
  });
}

export async function parseSynapseSource(
  path: string,
): Promise<ParsedSynapseProfiles> {
  return invoke<ParsedSynapseProfiles>("parse_synapse_source", { path });
}

/** Write the bundled Razer Synapse profile to Downloads (for the user to
 * import into Synapse) and optionally reveal the folder. Returns its path. */
export async function saveBundledSynapseProfile(reveal: boolean): Promise<string> {
  return invoke<string>("save_bundled_synapse_profile", { reveal });
}

/** Best-effort onboarding pre-flight: is Razer Synapse installed/running? */
export async function checkSynapseInstalled(): Promise<boolean> {
  return invoke<boolean>("check_synapse_installed");
}

/** Toggle "live capture" mode: while enabled, captured Naga keys are reported
 * to the UI (encoded_key_received) but NOT resolved/executed. Used by the
 * onboarding hardware test so buttons light up without firing real actions. */
export async function setInputCaptureMode(enabled: boolean): Promise<void> {
  return invoke<void>("set_input_capture_mode", { enabled });
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
}

export async function getAdminAutostartStatus(): Promise<AdminAutostartStatus> {
  return invoke<AdminAutostartStatus>("get_admin_autostart_status");
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

/**
 * Re-launch Sidearm with administrator privileges (UAC prompt) and exit the
 * current process.  Required to inject input into elevated foreground windows
 * (Task Manager, regedit, UAC dialogs) — Windows UIPI silently blocks
 * `SendInput` from a Medium-IL process to a High-IL one.
 */
export async function relaunchAsAdmin(): Promise<void> {
  return invoke<void>("relaunch_as_admin");
}

export async function getLogDirectory(): Promise<string> {
  return invoke<string>("get_log_directory");
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

export async function getExeIcon(exeName: string, processPath?: string): Promise<string | null> {
  return invoke<string | null>("get_exe_icon", { exeName, processPath: processPath ?? null });
}

// Narrow profile export/import IPC (FIXES P2-2). Two pairs mirror the two
// distinct export formats: the single-profile `ProfileExportData` (Profiles view)
// and the encoder-carrying bundle (Settings view). The backend validates the
// path (absolute + home-scoped + .json) so a compromised renderer cannot reach
// arbitrary files via these commands.
export async function exportProfileFile(path: string, contents: string): Promise<void> {
  return invoke<void>("export_profile", { path, contents });
}

export async function importProfileFile(path: string): Promise<string> {
  return invoke<string>("import_profile", { path });
}

export async function exportProfileBundle(path: string, contents: string): Promise<void> {
  return invoke<void>("export_profile_bundle", { path, contents });
}

export async function importProfileBundle(path: string): Promise<string> {
  return invoke<string>("import_profile_bundle", { path });
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
    return {
      code: typeof obj.code === "string" ? obj.code : "command_error",
      message:
        typeof obj.message === "string"
          ? obj.message
          : "Command failed.",
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
