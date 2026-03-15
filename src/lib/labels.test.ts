import { describe, it, expect } from "vitest";
import type {
  Binding,
  PhysicalControl,
  SequenceStep,
} from "./config";
import type { VerificationStepResult } from "./verification-session";
import type { ViewState } from "./constants";
import {
  formatTimestamp,
  logLevelBadgeClass,
  labelForControlFamily,
  labelForEncoderSource,
  labelForRuntimeStatus,
  labelForPreviewStatus,
  labelForExecutionOutcome,
  labelForExecutionMode,
  labelForPasteMode,
  labelForSequenceStep,
  badgeClassForCapability,
  labelForCapability,
  labelForLayer,
  labelForVerificationResult,
  actionCategoryIcon,
  stateLabel,
  surfacePrimaryLabel,
} from "./labels";
import { makeAction } from "./test-fixtures";

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe("formatTimestamp", () => {
  it("returns placeholder for null", () => {
    expect(formatTimestamp(null)).toBe("н/д");
  });

  it("returns locale string for valid timestamp", () => {
    const ts = new Date(2026, 0, 15, 10, 30, 0).getTime();
    const result = formatTimestamp(ts);
    // Should produce a non-empty string via toLocaleString
    expect(result).toBeTruthy();
    expect(result).not.toBe("н/д");
  });
});

// ---------------------------------------------------------------------------
// logLevelBadgeClass
// ---------------------------------------------------------------------------

describe("logLevelBadgeClass", () => {
  it("returns badge--info for info level", () => {
    expect(logLevelBadgeClass("info")).toBe("badge--info");
  });

  it("returns badge--warn for warn level", () => {
    expect(logLevelBadgeClass("warn")).toBe("badge--warn");
  });
});

// ---------------------------------------------------------------------------
// stateLabel
// ---------------------------------------------------------------------------

describe("stateLabel", () => {
  it.each<[ViewState, string]>([
    ["idle", "Ожидание"],
    ["loading", "Загрузка конфигурации"],
    ["ready", "Готово"],
    ["saving", "Сохранение"],
    ["error", "Ошибка"],
  ])("returns %s for %s state", (state, expected) => {
    expect(stateLabel(state)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// surfacePrimaryLabel
// ---------------------------------------------------------------------------

describe("surfacePrimaryLabel", () => {
  it("returns placeholder when no binding", () => {
    expect(surfacePrimaryLabel(null, null)).toBe("Не назначено");
  });

  it("returns disabled label when binding is not enabled", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "My Bind",
      actionRef: "a1",
      enabled: false,
    };
    expect(surfacePrimaryLabel(binding, null)).toBe("My Bind · отключено");
  });

  it("returns binding label when present and enabled", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "Custom Label",
      actionRef: "a1",
      enabled: true,
    };
    expect(surfacePrimaryLabel(binding, null)).toBe("Custom Label");
  });

  it("returns action pretty name when binding label is empty", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "",
      actionRef: "a1",
      enabled: true,
    };
    const action = makeAction({ type: "disabled", payload: {}, pretty: "Ctrl+C" });
    expect(surfacePrimaryLabel(binding, action)).toBe("Ctrl+C");
  });

  it("returns fallback when binding has no label and no action pretty", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "",
      actionRef: "a1",
      enabled: true,
    };
    const action = makeAction({ type: "disabled", payload: {}, pretty: "" });
    expect(surfacePrimaryLabel(binding, action)).toBe("Назначено");
  });

  it("returns fallback when binding has no label and action is null", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "",
      actionRef: "a1",
      enabled: true,
    };
    expect(surfacePrimaryLabel(binding, null)).toBe("Назначено");
  });
});

// ---------------------------------------------------------------------------
// Label functions
// ---------------------------------------------------------------------------

describe("labelForControlFamily", () => {
  it.each<[Parameters<typeof labelForControlFamily>[0], string]>([
    ["thumbGrid", "Боковая клавиатура"],
    ["topPanel", "Верхняя панель"],
    ["wheel", "Колесо"],
    ["system", "Системные контролы"],
  ])("returns correct label for %s", (family, expected) => {
    expect(labelForControlFamily(family)).toBe(expected);
  });
});

describe("labelForEncoderSource", () => {
  it("returns Synapse for synapse", () => {
    expect(labelForEncoderSource("synapse")).toBe("Synapse");
  });

  it("returns localized for detected", () => {
    expect(labelForEncoderSource("detected")).toBe("Обнаружен");
  });

  it("returns localized for reserved", () => {
    expect(labelForEncoderSource("reserved")).toBe("Зарезервирован");
  });

  it("returns placeholder for undefined", () => {
    expect(labelForEncoderSource(undefined)).toBe("н/д");
  });
});

describe("labelForRuntimeStatus", () => {
  it("returns running label", () => {
    expect(labelForRuntimeStatus("running")).toBe("Запущен");
  });

  it("returns stopped label for idle", () => {
    expect(labelForRuntimeStatus("idle")).toBe("Остановлен");
  });
});

describe("labelForPreviewStatus", () => {
  it.each<[string, string]>([
    ["resolved", "Найдено"],
    ["unresolved", "Не найдено"],
    ["ambiguous", "Неоднозначно"],
  ])("returns correct label for %s", (status, expected) => {
    expect(labelForPreviewStatus(status as "resolved" | "unresolved" | "ambiguous")).toBe(expected);
  });

  it("returns status as-is for unknown status", () => {
    expect(labelForPreviewStatus("custom" as never)).toBe("custom");
  });
});

describe("labelForExecutionOutcome", () => {
  it.each<[string, string]>([
    ["spawned", "Запущено"],
    ["injected", "Отправлено"],
    ["simulated", "Смоделировано"],
    ["noop", "Без действия"],
  ])("returns correct label for %s", (outcome, expected) => {
    expect(labelForExecutionOutcome(outcome as "spawned" | "injected" | "simulated" | "noop")).toBe(
      expected,
    );
  });

  it("returns outcome as-is for unknown outcome", () => {
    expect(labelForExecutionOutcome("custom" as never)).toBe("custom");
  });
});

describe("labelForExecutionMode", () => {
  it("returns live label", () => {
    expect(labelForExecutionMode("live")).toBe("Живой");
  });

  it("returns dry run label", () => {
    expect(labelForExecutionMode("dryRun")).toBe("Пробный");
  });
});

describe("labelForPasteMode", () => {
  it("returns clipboard paste label", () => {
    expect(labelForPasteMode("clipboardPaste")).toBe("буфер обмена");
  });

  it("returns direct input label", () => {
    expect(labelForPasteMode("sendText")).toBe("прямой ввод");
  });
});

describe("labelForSequenceStep", () => {
  it.each<[SequenceStep["type"], string]>([
    ["send", "Отправка сочетания"],
    ["text", "Ввод текста"],
    ["sleep", "Пауза"],
    ["launch", "Запуск"],
  ])("returns correct label for %s", (stepType, expected) => {
    expect(labelForSequenceStep(stepType)).toBe(expected);
  });
});

describe("labelForCapability", () => {
  it.each<[PhysicalControl["capabilityStatus"], string]>([
    ["verified", "Подтверждён"],
    ["needsValidation", "Нужна проверка"],
    ["reserved", "Зарезервирован"],
    ["partiallyRemappable", "Частично"],
  ])("returns correct label for %s", (status, expected) => {
    expect(labelForCapability(status)).toBe(expected);
  });
});

describe("labelForLayer", () => {
  it("returns standard label", () => {
    expect(labelForLayer("standard")).toBe("Стандартный");
  });

  it("returns hypershift label", () => {
    expect(labelForLayer("hypershift")).toBe("Hypershift");
  });
});

describe("labelForVerificationResult", () => {
  it.each<[VerificationStepResult, string]>([
    ["pending", "Ожидает"],
    ["matched", "Совпало"],
    ["mismatched", "Не совпало"],
    ["noSignal", "Нет сигнала"],
    ["skipped", "Пропущено"],
  ])("returns correct label for %s", (result, expected) => {
    expect(labelForVerificationResult(result)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// badgeClassForCapability
// ---------------------------------------------------------------------------

describe("badgeClassForCapability", () => {
  it.each<[PhysicalControl["capabilityStatus"], string]>([
    ["verified", "badge--ok"],
    ["needsValidation", "badge--warn"],
    ["reserved", "badge--muted"],
    ["partiallyRemappable", "badge--info"],
  ])("returns %s class for %s status", (status, expected) => {
    expect(badgeClassForCapability(status)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// actionCategoryIcon
// ---------------------------------------------------------------------------

describe("actionCategoryIcon", () => {
  it("returns correct icon for shortcut", () => {
    expect(actionCategoryIcon("shortcut")).toBe("KB");
  });

  it("returns correct icon for mouseAction", () => {
    expect(actionCategoryIcon("mouseAction")).toBe("MS");
  });

  it("returns correct icon for textSnippet", () => {
    expect(actionCategoryIcon("textSnippet")).toBe("Tx");
  });

  it("returns correct icon for sequence", () => {
    expect(actionCategoryIcon("sequence")).toBe("Sq");
  });

  it("returns correct icon for launch", () => {
    expect(actionCategoryIcon("launch")).toBe("Ex");
  });

  it("returns correct icon for mediaKey", () => {
    expect(actionCategoryIcon("mediaKey")).toBe("Md");
  });

  it("returns correct icon for profileSwitch", () => {
    expect(actionCategoryIcon("profileSwitch")).toBe("Pf");
  });

  it("returns correct icon for menu", () => {
    expect(actionCategoryIcon("menu")).toBe("Mn");
  });

  it("returns correct icon for disabled", () => {
    expect(actionCategoryIcon("disabled")).toBe("—");
  });

  it("returns dash fallback for unknown type", () => {
    expect(actionCategoryIcon("nonexistent" as never)).toBe("—");
  });
});
