import type { ActionType, ControlId, Layer, MappingSource, TriggerMode } from "./config";

export type RuntimeStatus = "idle" | "running";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeEventName =
  | "runtime_started"
  | "runtime_stopped"
  | "config_reloaded";

export type EncodedKeyEventName = "encoded_key_received";
export type WindowResolutionEventName = "profile_resolved";
export type ControlResolutionEventName = "control_resolved";
export type ActionExecutionEventName = "action_executed";
export type RuntimeErrorEventName = "runtime_error";

type ResolutionStatus = "resolved" | "unresolved" | "ambiguous" | "conditionUnmet";
type ExecutionMode = "dryRun" | "live";
type ExecutionOutcome = "spawned" | "injected" | "simulated" | "noop" | "switched";

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
  isKeyUp: boolean;
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
  isElevated: boolean;
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
  controlId?: ControlId;
  layer?: Layer;
  bindingId?: string;
  bindingLabel?: string;
  actionId?: string;
  actionType?: ActionType;
  actionPretty?: string;
  mappingVerified?: boolean;
  mappingSource?: MappingSource;
  triggerMode?: TriggerMode;
}

export interface ActionExecutionEvent {
  encodedKey: string;
  actionId: string;
  actionType: ActionType;
  actionPretty: string;
  resolvedProfileId?: string;
  resolvedProfileName?: string;
  matchedAppMappingId?: string;
  controlId?: ControlId;
  layer?: Layer;
  bindingId?: string;
  mode: ExecutionMode;
  outcome: ExecutionOutcome;
  processId?: number;
  summary: string;
  warnings: string[];
  executedAt: number;
}

/** Emitted when a binding's re-trigger was skipped inside its throttle window. */
export interface ThrottleBlockedEvent {
  controlId?: ControlId;
  bindingId?: string;
  remainingMs: number;
}

/** One past execution of a binding, kept FE-only (not persisted) for the
 *  per-control timeline shown in tooltips and the properties panel. */
export interface ExecutionRecord {
  actionPretty: string;
  executedAt: number;
  profileName: string;
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
  captureBackend: "windows-hotkey",
  activeConfigVersion: null,
  warningCount: 0,
};
