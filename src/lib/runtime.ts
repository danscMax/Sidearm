export type RuntimeStatus = "idle" | "running";

export type DebugLogLevel = "info" | "warn";

export type RuntimeEventName =
  | "runtime_started"
  | "runtime_stopped"
  | "config_reloaded";

export type EncodedKeyEventName = "encoded_key_received";
export type WindowResolutionEventName = "profile_resolved";
export type ControlResolutionEventName = "control_resolved";
export type ActionExecutionEventName = "action_executed";
export type RuntimeErrorEventName = "runtime_error";

export type ResolutionStatus = "resolved" | "unresolved" | "ambiguous";
export type ExecutionMode = "dryRun" | "live";
export type ExecutionOutcome = "spawned" | "injected" | "simulated" | "noop";

export interface RuntimeStateSummary {
  status: RuntimeStatus;
  startedAt: number | null;
  lastReloadAt: number | null;
  captureBackend: string;
  activeConfigVersion: number | null;
  warningCount: number;
}

export interface DebugLogEntry {
  id: number;
  level: DebugLogLevel;
  category: string;
  message: string;
  createdAt: number;
}

export interface EncodedKeyEvent {
  encodedKey: string;
  backend: string;
  receivedAt: number;
  isRepeat: boolean;
}

export interface WindowCaptureResult {
  hwnd: string;
  exe: string;
  processPath: string;
  title: string;
  capturedAt: number;
  ignored: boolean;
  ignoreReason?: string;
  matchedAppMappingId?: string;
  resolvedProfileId?: string;
  resolvedProfileName?: string;
  usedFallbackProfile: boolean;
  candidateAppMappingIds: string[];
  resolutionReason: string;
}

export interface ResolvedInputPreview {
  status: ResolutionStatus;
  encodedKey: string;
  reason: string;
  matchedAppMappingId?: string;
  resolvedProfileId?: string;
  resolvedProfileName?: string;
  usedFallbackProfile: boolean;
  candidateAppMappingIds: string[];
  candidateControlIds: string[];
  controlId?: string;
  layer?: string;
  bindingId?: string;
  bindingLabel?: string;
  actionId?: string;
  actionType?: string;
  actionPretty?: string;
  mappingVerified?: boolean;
  mappingSource?: string;
}

export interface ActionExecutionEvent {
  encodedKey: string;
  actionId: string;
  actionType: string;
  actionPretty: string;
  resolvedProfileId?: string;
  resolvedProfileName?: string;
  matchedAppMappingId?: string;
  controlId?: string;
  layer?: string;
  bindingId?: string;
  mode: ExecutionMode;
  outcome: ExecutionOutcome;
  processId?: number;
  summary: string;
  warnings: string[];
  executedAt: number;
}

export interface RuntimeErrorEvent {
  category: string;
  message: string;
  encodedKey?: string;
  actionId?: string;
  createdAt: number;
}

export const idleRuntimeStateSummary: RuntimeStateSummary = {
  status: "idle",
  startedAt: null,
  lastReloadAt: null,
  captureBackend: "windows-register-hotkey",
  activeConfigVersion: null,
  warningCount: 0,
};
