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
    return "н/д";
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
      return "Боковая клавиатура";
    case "topPanel":
      return "Верхняя панель";
    case "wheel":
      return "Колесо";
    case "system":
      return "Системные контролы";
  }
}

export function labelForEncoderSource(source: EncoderMapping["source"] | undefined): string {
  switch (source) {
    case "synapse":
      return "Synapse";
    case "detected":
      return "Обнаружен";
    case "reserved":
      return "Зарезервирован";
    default:
      return "н/д";
  }
}

export function labelForRuntimeStatus(status: RuntimeStateSummary["status"]): string {
  return status === "running" ? "Запущен" : "Остановлен";
}

export function labelForPreviewStatus(status: ResolvedInputPreview["status"]): string {
  switch (status) {
    case "resolved":
      return "Найдено";
    case "unresolved":
      return "Не найдено";
    case "ambiguous":
      return "Неоднозначно";
    default:
      return status;
  }
}

export function labelForExecutionOutcome(outcome: ActionExecutionEvent["outcome"]): string {
  switch (outcome) {
    case "spawned":
      return "Запущено";
    case "injected":
      return "Отправлено";
    case "simulated":
      return "Смоделировано";
    case "noop":
      return "Без действия";
    default:
      return outcome;
  }
}

export function labelForExecutionMode(mode: ActionExecutionEvent["mode"]): string {
  return mode === "live" ? "Живой" : "Пробный";
}

export function labelForPasteMode(mode: PasteMode): string {
  return mode === "clipboardPaste" ? "буфер обмена" : "прямой ввод";
}

export function labelForSequenceStep(stepType: SequenceStep["type"]): string {
  switch (stepType) {
    case "send":
      return "Отправка сочетания";
    case "text":
      return "Ввод текста";
    case "sleep":
      return "Пауза";
    case "launch":
      return "Запуск";
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
      return "Подтверждён";
    case "needsValidation":
      return "Нужна проверка";
    case "reserved":
      return "Зарезервирован";
    case "partiallyRemappable":
      return "Частично";
  }
}

export function labelForLayer(layer: Layer): string {
  return layer === "standard" ? "Стандартный" : "Hypershift";
}

export function labelForVerificationResult(result: VerificationStepResult): string {
  switch (result) {
    case "pending":
      return "Ожидает";
    case "matched":
      return "Совпало";
    case "mismatched":
      return "Не совпало";
    case "noSignal":
      return "Нет сигнала";
    case "skipped":
      return "Пропущено";
  }
}

export function actionCategoryIcon(actionType: ActionType): string {
  return ACTION_CATEGORIES.find((c) => c.actionType === actionType)?.icon ?? "—";
}

const CONTROL_DISPLAY_NAMES: Partial<Record<ControlId, string>> = {
  thumb_01: "Кнопка 1", thumb_02: "Кнопка 2", thumb_03: "Кнопка 3",
  thumb_04: "Кнопка 4", thumb_05: "Кнопка 5", thumb_06: "Кнопка 6",
  thumb_07: "Кнопка 7", thumb_08: "Кнопка 8", thumb_09: "Кнопка 9",
  thumb_10: "Кнопка 10", thumb_11: "Кнопка 11", thumb_12: "Кнопка 12",
  mouse_left: "ЛКМ", mouse_right: "ПКМ",
  mouse_4: "Назад", mouse_5: "Вперёд",
  wheel_up: "Прокрутка вверх", wheel_down: "Прокрутка вниз",
  wheel_click: "Клик колесом", wheel_left: "Колесо влево", wheel_right: "Колесо вправо",
  hypershift_button: "Razer Hypershift",
  top_aux_01: "Кнопка DPI+", top_aux_02: "Кнопка DPI−",
  top_special_01: "Доп. кнопка 1", top_special_02: "Доп. кнопка 2", top_special_03: "Доп. кнопка 3",
};

export function displayNameForControl(control: PhysicalControl): string {
  return CONTROL_DISPLAY_NAMES[control.id] ?? control.defaultName;
}

export function stateLabel(viewState: ViewState): string {
  switch (viewState) {
    case "idle":
      return "Ожидание";
    case "loading":
      return "Загрузка конфигурации";
    case "ready":
      return "Готово";
    case "saving":
      return "Сохранение";
    case "error":
      return "Ошибка";
  }
}

export function surfacePrimaryLabel(binding: Binding | null, action: Action | null): string {
  if (!binding) {
    return "Не назначено";
  }

  if (!binding.enabled) {
    return `${binding.label} · отключено`;
  }

  return binding.label || action?.pretty || "Назначено";
}
