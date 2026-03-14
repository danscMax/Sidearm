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
    const actionLabel = MOUSE_ACTION_OPTIONS.find((o) => o.value === payload.action)?.label ?? payload.action;
    const prefix = mods.length > 0 ? `${mods.join(" + ")} + ` : "";
    return `Мышь: ${prefix}${actionLabel}`;
  }

  if (action.type === "mediaKey") {
    const label = MEDIA_KEY_OPTIONS.find((o) => o.value === action.payload.key)?.label;
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

export function createDefaultSequenceStep(stepType: SequenceStep["type"]): SequenceStep {
  switch (stepType) {
    case "send":
      return { type: "send", value: "Ctrl+C" };
    case "text":
      return { type: "text", value: "Замените этот текст" };
    case "sleep":
      return { type: "sleep", delayMs: 100 };
    case "launch":
      return { type: "launch", value: "C:\\Путь\\К\\Программе.exe" };
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
        value: "value" in step ? step.value : "Ctrl+C",
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "text":
      return {
        type: "text",
        value: "value" in step ? step.value : "Замените этот текст",
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "sleep":
      return {
        type: "sleep",
        delayMs: "delayMs" in step ? step.delayMs ?? 100 : 100,
      };
    case "launch":
      return {
        type: "launch",
        value: "value" in step ? step.value : "C:\\Путь\\К\\Программе.exe",
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
  if (step.type === "sleep") {
    return {
      ...step,
      delayMs: nextDelay ?? 100,
    };
  }

  return {
    ...step,
    delayMs: nextDelay,
  };
}
