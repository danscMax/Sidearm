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
import { MEDIA_KEY_OPTIONS, MOUSE_ACTION_OPTIONS } from "./constants";
import { labelForPasteMode } from "./labels";

export function describeActionSummary(
  action: Action | null,
  snippetsById: Map<string, SnippetLibraryItem>,
): string {
  if (!action) {
    return "Предпросмотр действия отсутствует.";
  }

  if (action.type === "shortcut") {
    const modifiers = [
      action.payload.ctrl ? "Ctrl" : null,
      action.payload.shift ? "Shift" : null,
      action.payload.alt ? "Alt" : null,
      action.payload.win ? "Win" : null,
      action.payload.key,
    ].filter(Boolean);

    return `Шорткат: ${modifiers.join(" + ")}`;
  }

  if (action.type === "mouseAction") {
    const { payload } = action;
    const mods = [
      payload.ctrl ? "Ctrl" : null,
      payload.shift ? "Shift" : null,
      payload.alt ? "Alt" : null,
      payload.win ? "Win" : null,
    ].filter(Boolean);
    const actionLabel = mouseActionLabel(payload.action) ?? payload.action;
    const prefix = mods.length > 0 ? `${mods.join(" + ")} + ` : "";
    return `Мышь: ${prefix}${actionLabel}`;
  }

  if (action.type === "mediaKey") {
    const label = mediaKeyLabel(action.payload.key);
    return `Медиа: ${label ?? action.payload.key}`;
  }

  if (action.type === "profileSwitch") {
    return `Профиль: ${action.payload.targetProfileId}`;
  }

  if (action.type === "textSnippet") {
    if (action.payload.source === "libraryRef") {
      const snippet = snippetsById.get(action.payload.snippetId);
      return snippet
        ? `Фрагмент из библиотеки: ${snippet.name}`
        : `Ссылка на библиотеку фрагментов: ${action.payload.snippetId}`;
    }

    return `Встроенный фрагмент через ${labelForPasteMode(action.payload.pasteMode)}`;
  }

  if (action.type === "sequence") {
    return `Последовательность из ${action.payload.steps.length} шаг(ов).`;
  }

  if (action.type === "launch") {
    return `Цель запуска: ${action.payload.target}`;
  }

  if (action.type === "menu") {
    return `Меню из ${action.payload.items.length} пункт(ов).`;
  }

  return action.notes ?? "Отключённое действие-заглушка.";
}

/** Human label for a mouse-action value (from `MOUSE_ACTION_OPTIONS`), or
 *  `undefined` if unknown — callers supply their own fallback. Shared by
 *  `describeActionSummary` and the picker's `autoName`. */
export function mouseActionLabel(value: string): string | undefined {
  return MOUSE_ACTION_OPTIONS.find((o) => o.value === value)?.label;
}

/** Human label for a media-key value (from `MEDIA_KEY_OPTIONS`), or undefined. */
export function mediaKeyLabel(value: string): string | undefined {
  return MEDIA_KEY_OPTIONS.find((o) => o.value === value)?.label;
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
