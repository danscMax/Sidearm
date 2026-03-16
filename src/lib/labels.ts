import i18n from "../i18n";
import type {
  ActionType,
  Binding,
  Action,
  ControlFamily,
  ControlId,
  EncoderMapping,
  Layer,
  PasteMode,
  PhysicalControl,
  SequenceStep,
} from "./config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  ResolvedInputPreview,
  RuntimeStateSummary,
} from "./runtime";
import type { VerificationStepResult } from "./verification-session";
import { ACTION_CATEGORIES, type ViewState } from "./constants";

export function formatTimestamp(timestamp: number | null): string {
  if (timestamp == null) {
    return i18n.t("common.na");
  }

  return new Date(timestamp).toLocaleString();
}

export function logLevelBadgeClass(level: DebugLogEntry["level"]): string {
  switch (level) {
    case "debug":
      return "badge--debug";
    case "info":
      return "badge--info";
    case "warn":
      return "badge--warn";
    case "error":
      return "badge--error";
  }
}

export function labelForControlFamily(family: ControlFamily): string {
  switch (family) {
    case "thumbGrid":
      return i18n.t("control.family.thumbGrid");
    case "topPanel":
      return i18n.t("control.family.topPanel");
    case "wheel":
      return i18n.t("control.family.wheel");
    case "system":
      return i18n.t("control.family.system");
  }
}

export function labelForEncoderSource(source: EncoderMapping["source"] | undefined): string {
  switch (source) {
    case "synapse":
      return i18n.t("encoder.synapse");
    case "detected":
      return i18n.t("encoder.detected");
    case "reserved":
      return i18n.t("encoder.reserved");
    default:
      return i18n.t("common.na");
  }
}

export function labelForRuntimeStatus(status: RuntimeStateSummary["status"]): string {
  return status === "running" ? i18n.t("runtime.statusRunning") : i18n.t("runtime.statusStopped");
}

export function labelForPreviewStatus(status: ResolvedInputPreview["status"]): string {
  switch (status) {
    case "resolved":
      return i18n.t("preview.resolved");
    case "unresolved":
      return i18n.t("preview.unresolved");
    case "ambiguous":
      return i18n.t("preview.ambiguous");
    default:
      return status;
  }
}

export function labelForExecutionOutcome(outcome: ActionExecutionEvent["outcome"]): string {
  switch (outcome) {
    case "spawned":
      return i18n.t("execution.spawned");
    case "injected":
      return i18n.t("execution.injected");
    case "simulated":
      return i18n.t("execution.simulated");
    case "noop":
      return i18n.t("execution.noop");
    default:
      return outcome;
  }
}

export function labelForExecutionMode(mode: ActionExecutionEvent["mode"]): string {
  return mode === "live" ? i18n.t("execution.modeLive") : i18n.t("execution.modeTest");
}

export function labelForPasteMode(mode: PasteMode): string {
  return mode === "clipboardPaste" ? i18n.t("paste.clipboard") : i18n.t("paste.direct");
}

export function labelForSequenceStep(stepType: SequenceStep["type"]): string {
  switch (stepType) {
    case "send":
      return i18n.t("sequence.send");
    case "text":
      return i18n.t("sequence.text");
    case "sleep":
      return i18n.t("sequence.sleep");
    case "launch":
      return i18n.t("sequence.launch");
  }
}

export function badgeClassForCapability(status: PhysicalControl["capabilityStatus"]): string {
  switch (status) {
    case "verified": return "badge--ok";
    case "needsValidation": return "badge--warn";
    case "reserved": return "badge--muted";
    case "partiallyRemappable": return "badge--info";
  }
}

export function labelForCapability(controlStatus: PhysicalControl["capabilityStatus"]): string {
  switch (controlStatus) {
    case "verified":
      return i18n.t("control.capability.verified");
    case "needsValidation":
      return i18n.t("control.capability.needsValidation");
    case "reserved":
      return i18n.t("control.capability.reserved");
    case "partiallyRemappable":
      return i18n.t("control.capability.partiallyRemappable");
  }
}

export function labelForLayer(layer: Layer): string {
  return layer === "standard" ? i18n.t("layer.standard") : i18n.t("layer.hypershift");
}

export function labelForVerificationResult(result: VerificationStepResult): string {
  switch (result) {
    case "pending":
      return i18n.t("verification.pending");
    case "matched":
      return i18n.t("verification.matched");
    case "mismatched":
      return i18n.t("verification.mismatched");
    case "noSignal":
      return i18n.t("verification.noSignal");
    case "skipped":
      return i18n.t("verification.skipped");
  }
}

export function actionCategoryIcon(actionType: ActionType): string {
  return ACTION_CATEGORIES.find((c) => c.actionType === actionType)?.icon ?? "—";
}

const CONTROL_ID_TO_I18N_KEY: Partial<Record<ControlId, string>> = {
  thumb_01: "control.name.thumb01",
  thumb_02: "control.name.thumb02",
  thumb_03: "control.name.thumb03",
  thumb_04: "control.name.thumb04",
  thumb_05: "control.name.thumb05",
  thumb_06: "control.name.thumb06",
  thumb_07: "control.name.thumb07",
  thumb_08: "control.name.thumb08",
  thumb_09: "control.name.thumb09",
  thumb_10: "control.name.thumb10",
  thumb_11: "control.name.thumb11",
  thumb_12: "control.name.thumb12",
  mouse_left: "control.name.mouseLeft",
  mouse_right: "control.name.mouseRight",
  mouse_4: "control.name.mouseBack",
  mouse_5: "control.name.mouseForward",
  wheel_up: "control.name.wheelUp",
  wheel_down: "control.name.wheelDown",
  wheel_click: "control.name.wheelClick",
  wheel_left: "control.name.wheelLeft",
  wheel_right: "control.name.wheelRight",
  hypershift_button: "control.name.hypershift",
  top_aux_01: "control.name.dpiPlus",
  top_aux_02: "control.name.dpiMinus",
  top_special_01: "control.name.special01",
  top_special_02: "control.name.special02",
  top_special_03: "control.name.special03",
};

export function displayNameForControl(control: PhysicalControl): string {
  const key = CONTROL_ID_TO_I18N_KEY[control.id];
  return key ? i18n.t(key) : control.defaultName;
}

export function stateLabel(viewState: ViewState): string {
  switch (viewState) {
    case "idle":
      return i18n.t("viewState.idle");
    case "loading":
      return i18n.t("viewState.loading");
    case "ready":
      return i18n.t("viewState.ready");
    case "saving":
      return i18n.t("viewState.saving");
    case "error":
      return i18n.t("viewState.error");
  }
}

export function surfacePrimaryLabel(binding: Binding | null, action: Action | null): string {
  if (!binding) {
    return i18n.t("binding.notAssigned");
  }

  if (!binding.enabled) {
    return `${binding.label} · ${i18n.t("binding.disabledSuffix")}`;
  }

  return binding.label || action?.pretty || i18n.t("binding.assigned");
}
