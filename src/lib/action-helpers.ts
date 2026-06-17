import type {
  Action,
  AppConfig,
  LaunchActionPayload,
  MenuActionPayload,
  SequenceActionPayload,
  SequenceStep,
  ShortcutActionPayload,
  SnippetLibraryItem,
  TextSnippetPayload,
} from "./config";
import i18n from "../i18n";
import { MEDIA_KEY_OPTIONS, MOUSE_ACTION_OPTIONS } from "./constants";
import { labelForPasteMode } from "./labels";

/** Active keyboard-modifier labels in canonical Ctrl→Shift→Alt→Win order. */
export function modifierLabels(m: {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  win?: boolean;
}): string[] {
  return [
    m.ctrl ? "Ctrl" : null,
    m.shift ? "Shift" : null,
    m.alt ? "Alt" : null,
    m.win ? "Win" : null,
  ].filter(Boolean) as string[];
}

export function describeActionSummary(
  action: Action | null,
  snippetsById: Map<string, SnippetLibraryItem>,
): string {
  if (!action) {
    return i18n.t("actionSummary.none");
  }

  if (action.type === "shortcut") {
    const modifiers = [...modifierLabels(action.payload), action.payload.key].filter(Boolean);
    return i18n.t("actionSummary.shortcut", { value: modifiers.join(" + ") });
  }

  if (action.type === "mouseAction") {
    const { payload } = action;
    const mods = modifierLabels(payload);
    const actionLabel = mouseActionLabel(payload.action) ?? payload.action;
    const prefix = mods.length > 0 ? `${mods.join(" + ")} + ` : "";
    return i18n.t("actionSummary.mouse", { value: `${prefix}${actionLabel}` });
  }

  if (action.type === "mediaKey") {
    const label = mediaKeyLabel(action.payload.key);
    return i18n.t("actionSummary.media", { value: label ?? action.payload.key });
  }

  if (action.type === "profileSwitch") {
    return i18n.t("actionSummary.profile", { value: action.payload.targetProfileId });
  }

  if (action.type === "textSnippet") {
    if (action.payload.source === "libraryRef") {
      const snippet = snippetsById.get(action.payload.snippetId);
      return snippet
        ? i18n.t("actionSummary.snippetLibrary", { name: snippet.name })
        : i18n.t("actionSummary.snippetRef", { id: action.payload.snippetId });
    }

    return i18n.t("actionSummary.snippetInline", {
      mode: labelForPasteMode(action.payload.pasteMode),
    });
  }

  if (action.type === "sequence") {
    return i18n.t("actionSummary.sequence", { count: action.payload.steps.length });
  }

  if (action.type === "launch") {
    return i18n.t("actionSummary.launch", { target: action.payload.target });
  }

  if (action.type === "menu") {
    return i18n.t("actionSummary.menu", { count: action.payload.items.length });
  }

  if (action.type === "repairClipboard") {
    return i18n.t("actionSummary.repairClipboard");
  }

  return action.notes ?? i18n.t("actionSummary.disabledFallback");
}

/** Human label for a mouse-action value (from `MOUSE_ACTION_OPTIONS`), or
 *  `undefined` if unknown — callers supply their own fallback. The option's
 *  `label` is an i18n key, resolved here at call time. Shared by
 *  `describeActionSummary` and the picker's `autoName`. */
export function mouseActionLabel(value: string): string | undefined {
  const option = MOUSE_ACTION_OPTIONS.find((o) => o.value === value);
  return option ? i18n.t(option.label) : undefined;
}

/** Human label for a media-key value (from `MEDIA_KEY_OPTIONS`), or undefined.
 *  The option's `label` is an i18n key, resolved here at call time. */
export function mediaKeyLabel(value: string): string | undefined {
  const option = MEDIA_KEY_OPTIONS.find((o) => o.value === value);
  return option ? i18n.t(option.label) : undefined;
}

export function isActionLiveRunnable(config: AppConfig, actionId: string): boolean {
  const action = config.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    return false;
  }

  if (action.type === "shortcut") {
    return Boolean(action.payload.key);
  }

  if (action.type === "textSnippet") {
    const payload = action.payload;
    if (payload.source === "inline") {
      return true;
    }

    const snippet = config.snippetLibrary.find(
      (candidate) => candidate.id === payload.snippetId,
    );
    return Boolean(snippet);
  }

  if (action.type === "sequence") {
    return action.payload.steps.length > 0;
  }

  if (action.type === "launch") {
    return Boolean(action.payload.target);
  }

  if (action.type === "disabled") {
    return true;
  }

  // mediaKey and mouseAction are executed live by the backend
  // (executor.rs run_live_mouse_action / run_live_media_key_action),
  // so the "Execute live" button must be enabled for them too.
  if (action.type === "mouseAction" || action.type === "mediaKey") {
    return true;
  }

  if (action.type === "repairClipboard") {
    return true;
  }

  return false;
}

export function withShortcutPayload(
  action: Action,
  updatePayload: (payload: ShortcutActionPayload) => ShortcutActionPayload,
): Action {
  if (action.type !== "shortcut") {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload),
  };
}

export function withTextSnippetPayload(
  action: Action,
  updatePayload: (payload: TextSnippetPayload) => TextSnippetPayload,
): Action {
  if (action.type !== "textSnippet") {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload),
  };
}

export function withSequencePayload(
  action: Action,
  updatePayload: (payload: SequenceActionPayload) => SequenceActionPayload,
): Action {
  if (action.type !== "sequence") {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload),
  };
}

export function withLaunchPayload(
  action: Action,
  updatePayload: (payload: LaunchActionPayload) => LaunchActionPayload,
): Action {
  if (action.type !== "launch") {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload),
  };
}

export function withMenuPayload(
  action: Action,
  updatePayload: (payload: MenuActionPayload) => MenuActionPayload,
): Action {
  if (action.type !== "menu") {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload),
  };
}

/** Default payloads for a new/converted sequence step (single source). */
const SEQUENCE_STEP_DEFAULT_SEND = "Ctrl+C";
const SEQUENCE_STEP_DEFAULT_TEXT = "Замените этот текст";
const SEQUENCE_STEP_DEFAULT_SLEEP_MS = 100;
const SEQUENCE_STEP_DEFAULT_LAUNCH = "C:\\Путь\\К\\Программе.exe";

export function createDefaultSequenceStep(stepType: SequenceStep["type"]): SequenceStep {
  switch (stepType) {
    case "send":
      return { type: "send", value: SEQUENCE_STEP_DEFAULT_SEND };
    case "text":
      return { type: "text", value: SEQUENCE_STEP_DEFAULT_TEXT };
    case "sleep":
      return { type: "sleep", delayMs: SEQUENCE_STEP_DEFAULT_SLEEP_MS };
    case "launch":
      return { type: "launch", value: SEQUENCE_STEP_DEFAULT_LAUNCH };
  }
}

export function coerceSequenceStepType(
  step: SequenceStep,
  nextType: SequenceStep["type"],
): SequenceStep {
  if (step.type === nextType) {
    return step;
  }

  switch (nextType) {
    case "send":
      return {
        type: "send",
        value: "value" in step ? step.value : SEQUENCE_STEP_DEFAULT_SEND,
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "text":
      return {
        type: "text",
        value: "value" in step ? step.value : SEQUENCE_STEP_DEFAULT_TEXT,
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "sleep":
      return {
        type: "sleep",
        delayMs: "delayMs" in step ? step.delayMs ?? SEQUENCE_STEP_DEFAULT_SLEEP_MS : SEQUENCE_STEP_DEFAULT_SLEEP_MS,
      };
    case "launch":
      return {
        type: "launch",
        value: "value" in step ? step.value : SEQUENCE_STEP_DEFAULT_LAUNCH,
        args: step.type === "launch" ? step.args : undefined,
        workingDir: step.type === "launch" ? step.workingDir : undefined,
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
  }
}

export function setSequenceStepDelay(
  step: SequenceStep,
  nextDelay: number | undefined,
): SequenceStep {
  // Clamp negative delays to 0 — a negative delayMs would serialize to a
  // negative JSON number and fail Rust's u32 deserialization on save/load.
  const clamped = nextDelay === undefined ? undefined : Math.max(0, nextDelay);
  if (step.type === "sleep") {
    return {
      ...step,
      delayMs: clamped ?? 100,
    };
  }

  return {
    ...step,
    delayMs: clamped,
  };
}
