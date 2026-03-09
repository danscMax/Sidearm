import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppConfig,
  CommandError,
  LoadConfigResponse,
  SaveConfigResponse,
} from "./config";
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

export async function startRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("start_runtime");
}

export async function stopRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("stop_runtime");
}

export async function reloadRuntime(): Promise<RuntimeStateSummary> {
  return invoke<RuntimeStateSummary>("reload_runtime");
}

export async function getDebugLog(): Promise<DebugLogEntry[]> {
  return invoke<DebugLogEntry[]>("get_debug_log");
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

export async function exportVerificationSession(
  path: string,
  contents: string,
): Promise<string> {
  return invoke<string>("export_verification_session", { path, contents });
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

export function normalizeCommandError(error: unknown): CommandError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  ) {
    const candidate = error as Partial<CommandError>;
    return {
      code: typeof candidate.code === "string" ? candidate.code : "command_error",
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : "Command failed.",
      details: Array.isArray(candidate.details)
        ? candidate.details.filter(
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
