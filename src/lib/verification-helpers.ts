import type { ControlId } from "./config";
import type {
  VerificationSession,
  VerificationStepResult,
} from "./verification-session";

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
