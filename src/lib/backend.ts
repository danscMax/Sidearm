import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export async function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function exportVerificationSession(
  filename: string,
  contents: string,
): Promise<string> {
  return invoke<string>("export_verification_session", { filename, contents });
}

export async function listenRuntimeEvent(
  eventName: RuntimeEventName,
  onPayload: (payload: RuntimeStateSummary) => void,
): Promise<UnlistenFn> {
  return listen<RuntimeStateSummary>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenWindowResolutionEvent(
  eventName: WindowResolutionEventName,
  onPayload: (payload: WindowCaptureResult) => void,
): Promise<UnlistenFn> {
  return listen<WindowCaptureResult>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenEncodedKeyEvent(
  eventName: EncodedKeyEventName,
  onPayload: (payload: EncodedKeyEvent) => void,
): Promise<UnlistenFn> {
  return listen<EncodedKeyEvent>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenControlResolutionEvent(
  eventName: ControlResolutionEventName,
  onPayload: (payload: ResolvedInputPreview) => void,
): Promise<UnlistenFn> {
  return listen<ResolvedInputPreview>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenActionExecutionEvent(
  eventName: ActionExecutionEventName,
  onPayload: (payload: ActionExecutionEvent) => void,
): Promise<UnlistenFn> {
  return listen<ActionExecutionEvent>(eventName, (event) => {
    onPayload(event.payload);
  });
}

export async function listenRuntimeErrorEvent(
  eventName: RuntimeErrorEventName,
  onPayload: (payload: RuntimeErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<RuntimeErrorEvent>(eventName, (event) => {
    onPayload(event.payload);
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
