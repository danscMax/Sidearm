import type {
  Action,
  ActionType,
  AppConfig,
  AppMapping,
  Binding,
  ControlFamily,
  EncoderMapping,
  ControlId,
  LaunchActionPayload,
  Layer,
  MenuActionPayload,
  MenuItem,
  PasteMode,
  PhysicalControl,
  SequenceActionPayload,
  SequenceStep,
  ShortcutActionPayload,
  SnippetLibraryItem,
  TextSnippetPayload,
} from "./config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  ResolvedInputPreview,
  RuntimeStateSummary,
} from "./runtime";
import type {
  VerificationSession,
  VerificationStepResult,
} from "./verification-session";
import {
  ACTION_CATEGORIES,
  MEDIA_KEY_OPTIONS,
  MOUSE_ACTION_OPTIONS,
  type ViewState,
} from "./constants";

/** Look up human-readable button name from its ControlId, falling back to the raw ID. */
export function controlName(controls: readonly PhysicalControl[], id: string): string {
  return controls.find((c) => c.id === id)?.defaultName ?? id;
}

export function resolveInitialProfileId(config: AppConfig): string | null {
  return (
    config.profiles.find((profile) => profile.id === config.settings.fallbackProfileId)?.id ??
    config.profiles[0]?.id ??
    null
  );
}

export function resolveInitialControlId(config: AppConfig): ControlId | null {
  return (
    config.physicalControls.find((control) => control.family === "thumbGrid")?.id ??
    config.physicalControls[0]?.id ??
    null
  );
}


export function sortAppMappings(mappings: AppMapping[]): AppMapping[] {
  return [...mappings].sort(
    (left, right) =>
      right.priority - left.priority || left.exe.localeCompare(right.exe),
  );
}

export function parseCommaSeparatedUniqueValues(value: string): string[] {
  const seen = new Set<string>();

  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag)) {
        return false;
      }

      seen.add(tag);
      return true;
    });
}

export function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}


export function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : undefined;
}


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
    const label = MOUSE_ACTION_OPTIONS.find((o) => o.value === action.payload.action)?.label;
    return `Мышь: ${label ?? action.payload.action}`;
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

export function describeVerificationAlignment(
  expectedEncodedKey: string | null,
  configuredEncodedKey: string | null,
  observedEncodedKey: string | null,
  observedMatchesSelectedControl: boolean,
): { title: string; body: string; noticeClass: string } {
  if (!expectedEncodedKey && !configuredEncodedKey) {
    return {
      title: "Ожидаемый сигнал ещё не задан",
      body: "Для этой кнопки пока не задан ожидаемый сигнал. Нажмите кнопку на мыши, чтобы зафиксировать сигнал, или создайте его вручную.",
      noticeClass: "notice--info",
    };
  }

  if (!configuredEncodedKey && expectedEncodedKey) {
    return {
      title: "Ожидаемый сигнал известен, но ещё не настроен",
      body: `Создайте сигнал «${expectedEncodedKey}», сохраните конфигурацию, запустите перехват и затем нажмите физическую кнопку для проверки.`,
      noticeClass: "notice--warning",
    };
  }

  if (
    expectedEncodedKey &&
    configuredEncodedKey &&
    expectedEncodedKey !== configuredEncodedKey
  ) {
    return {
      title: "Настроенный сигнал расходится с ожидаемым",
      body: `Сейчас конфигурация использует \`${configuredEncodedKey}\`, хотя план проверки ожидает \`${expectedEncodedKey}\`. Это может быть специально, но требует явного подтверждения.`,
      noticeClass: "notice--warning",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey === configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: "Наблюдаемый сигнал совпадает с настроенным",
      body: `Последнее событие перехвата сообщило \`${observedEncodedKey}\` для этой кнопки и слоя. Это сильный сигнал, что настройку можно пометить как подтверждённую.`,
      noticeClass: "notice--ok",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey !== configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: "Наблюдаемый сигнал отличается от настроенного",
      body: `Последнее событие перехвата сообщило \`${observedEncodedKey}\`, но конфигурация сейчас ожидает \`${configuredEncodedKey}\`. Сначала приведите сигнал в порядок, потом доверяйте живому выполнению.`,
      noticeClass: "notice--warning",
    };
  }

  return {
    title: "Настроенный сигнал готов к проверке",
    body: "Сохраните текущую конфигурацию, запустите перехват и нажмите выбранную физическую кнопку. Следующее событие покажет, воспроизводится ли сигнал.",
    noticeClass: "notice--subtle",
  };
}


export function describeVerificationSessionSuggestion(
  result: Exclude<VerificationStepResult, "pending">,
  step: VerificationSession["steps"][number],
): string {
  switch (result) {
    case "matched":
      return `Наблюдаемый сигнал \`${step.observedEncodedKey}\` совпал с настроенным и выглядит как корректное попадание в текущую кнопку.`;
    case "mismatched":
      return step.observedEncodedKey
        ? `Сейчас пришёл \`${step.observedEncodedKey}\`, но этого недостаточно для чистого совпадения с ожидаемой конфигурацией.`
        : "Наблюдение не дало чистого совпадения.";
    case "noSignal":
      return "После старта шага приложение пока не увидело нового сигнала. Проверьте runtime, сохранённую конфигурацию и саму кнопку.";
    case "skipped":
      return "Шаг пропущен пользователем.";
  }
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

export function collectMenuItemIds(items: MenuItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "submenu"
      ? [item.id, ...collectMenuItemIds(item.items)]
      : [item.id],
  );
}

export function appendMenuItem(
  items: MenuItem[],
  parentId: string | null,
  nextItem: MenuItem,
): MenuItem[] {
  if (parentId === null) {
    return [...items, nextItem];
  }

  return items.map((item) => {
    if (item.kind === "submenu") {
      if (item.id === parentId) {
        return {
          ...item,
          items: [...item.items, nextItem],
        };
      }

      return {
        ...item,
        items: appendMenuItem(item.items, parentId, nextItem),
      };
    }

    return item;
  });
}

export function updateMenuItem(
  items: MenuItem[],
  targetId: string,
  updateItem: (item: MenuItem) => MenuItem,
): MenuItem[] {
  return items.map((item) => {
    if (item.id === targetId) {
      return updateItem(item);
    }

    if (item.kind === "submenu") {
      return {
        ...item,
        items: updateMenuItem(item.items, targetId, updateItem),
      };
    }

    return item;
  });
}

export function removeMenuItem(items: MenuItem[], targetId: string): MenuItem[] {
  return items
    .filter((item) => item.id !== targetId)
    .map((item) =>
      item.kind === "submenu"
        ? {
            ...item,
            items: removeMenuItem(item.items, targetId),
          }
        : item,
    )
    .filter((item) => !(item.kind === "submenu" && item.items.length === 0));
}

export function formatTimestamp(timestamp: number | null): string {
  if (timestamp == null) {
    return "н/д";
  }

  return new Date(timestamp).toLocaleString();
}

export function logLevelBadgeClass(level: DebugLogEntry["level"]): string {
  switch (level) {
    case "info":
      return "badge--info";
    case "warn":
      return "badge--warn";
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

export const controlPhysicalHint: Partial<Record<ControlId, string>> = {
  thumb_01: "Нижний левый на боковой клавиатуре (ряд 1, столбец 1)",
  thumb_02: "Второй снизу, левый столбец (ряд 2, столбец 1)",
  thumb_03: "Верхний левый на боковой клавиатуре (ряд 3, столбец 1)",
  thumb_04: "Нижний во втором столбце (ряд 1, столбец 2)",
  thumb_05: "Средний во втором столбце (ряд 2, столбец 2)",
  thumb_06: "Верхний во втором столбце (ряд 3, столбец 2)",
  thumb_07: "Нижний в третьем столбце (ряд 1, столбец 3)",
  thumb_08: "Средний в третьем столбце (ряд 2, столбец 3)",
  thumb_09: "Верхний в третьем столбце (ряд 3, столбец 3)",
  thumb_10: "Нижний правый на боковой клавиатуре (ряд 1, столбец 4)",
  thumb_11: "Второй снизу, правый столбец (ряд 2, столбец 4)",
  thumb_12: "Верхний правый на боковой клавиатуре (ряд 3, столбец 4)",
  mouse_left: "Левая кнопка мыши (основной клик)",
  mouse_right: "Правая кнопка мыши",
  mouse_4: "Боковая кнопка «Назад» (ближняя к большому пальцу сверху)",
  mouse_5: "Боковая кнопка «Вперёд» (дальняя от большого пальца сверху)",
  top_aux_01: "Кнопка рядом с колесом (предположительно DPI+)",
  top_aux_02: "Вторая кнопка рядом с колесом (предположительно DPI−)",
  wheel_up: "Прокрутка колеса вверх",
  wheel_down: "Прокрутка колеса вниз",
  wheel_click: "Нажатие на колесо (средний клик)",
  wheel_left: "Наклон колеса влево",
  wheel_right: "Наклон колеса вправо",
  hypershift_button: "Кнопка Hypershift (нижняя на корпусе, под большим пальцем)",
};

export function actionCategoryIcon(actionType: ActionType): string {
  return ACTION_CATEGORIES.find((c) => c.actionType === actionType)?.icon ?? "—";
}

export function dotLabel(controlId: string): string {
  const thumbMatch = controlId.match(/^thumb_(\d+)$/);
  if (thumbMatch) return thumbMatch[1].replace(/^0/, "");
  const labels: Record<string, string> = {
    mouse_4: "←",
    mouse_5: "→",
    wheel_up: "↑",
    wheel_down: "↓",
    wheel_click: "⊙",
    top_aux_01: "D+",
    top_aux_02: "D−",
  };
  return labels[controlId] ?? "?";
}

export function verificationResultColor(result: VerificationStepResult): string {
  switch (result) {
    case "matched":
      return "var(--c-ok)";
    case "mismatched":
      return "var(--c-danger)";
    case "noSignal":
      return "var(--c-warning)";
    case "skipped":
      return "var(--c-text-muted)";
    case "pending":
      return "var(--c-border)";
  }
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
