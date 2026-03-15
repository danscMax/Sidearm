import { describe, it, expect } from "vitest";
import type {
  PasteMode,
  SequenceStep,
  SnippetLibraryItem,
} from "./config";
import {
  describeActionSummary,
  isActionLiveRunnable,
  withShortcutPayload,
  withTextSnippetPayload,
  withSequencePayload,
  withLaunchPayload,
  withMenuPayload,
  createDefaultSequenceStep,
  coerceSequenceStepType,
  setSequenceStepDelay,
} from "./action-helpers";
import { makeConfig, makeAction, makeSnippetMap, emptySnippets } from "./test-fixtures";

// ---------------------------------------------------------------------------
// describeActionSummary
// ---------------------------------------------------------------------------

describe("describeActionSummary", () => {
  it("returns fallback text for null action", () => {
    expect(describeActionSummary(null, emptySnippets)).toBe(
      "Предпросмотр действия отсутствует.",
    );
  });

  it("describes shortcut with modifiers", () => {
    const action = makeAction({
      type: "shortcut",
      payload: { key: "C", ctrl: true, shift: true, alt: false, win: false },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Шорткат: Ctrl + Shift + C");
  });

  it("describes shortcut with no modifiers", () => {
    const action = makeAction({
      type: "shortcut",
      payload: { key: "F5", ctrl: false, shift: false, alt: false, win: false },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Шорткат: F5");
  });

  it("describes shortcut with all modifiers", () => {
    const action = makeAction({
      type: "shortcut",
      payload: { key: "A", ctrl: true, shift: true, alt: true, win: true },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Шорткат: Ctrl + Shift + Alt + Win + A",
    );
  });

  it("describes textSnippet with inline source", () => {
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "inline", text: "hello", pasteMode: "clipboardPaste" as PasteMode, tags: [] },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Встроенный фрагмент через буфер обмена",
    );
  });

  it("describes textSnippet with inline source using sendText paste mode", () => {
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "inline", text: "hello", pasteMode: "sendText" as PasteMode, tags: [] },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Встроенный фрагмент через прямой ввод",
    );
  });

  it("describes textSnippet with libraryRef and existing snippet", () => {
    const snippet: SnippetLibraryItem = {
      id: "s1",
      name: "My Snippet",
      text: "text",
      pasteMode: "clipboardPaste",
      tags: [],
    };
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "libraryRef", snippetId: "s1" },
    });
    expect(describeActionSummary(action, makeSnippetMap([snippet]))).toBe(
      "Фрагмент из библиотеки: My Snippet",
    );
  });

  it("describes textSnippet with libraryRef and missing snippet", () => {
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "libraryRef", snippetId: "missing" },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Ссылка на библиотеку фрагментов: missing",
    );
  });

  it("describes sequence action", () => {
    const action = makeAction({
      type: "sequence",
      payload: {
        steps: [
          { type: "send", value: "Ctrl+C" },
          { type: "sleep", delayMs: 100 },
          { type: "text", value: "done" },
        ],
      },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Последовательность из 3 шаг(ов).",
    );
  });

  it("describes launch action", () => {
    const action = makeAction({
      type: "launch",
      payload: { target: "C:\\app.exe" },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Цель запуска: C:\\app.exe");
  });

  it("describes menu action", () => {
    const action = makeAction({
      type: "menu",
      payload: {
        items: [
          { kind: "action", id: "mi1", label: "Item", actionRef: "a1", enabled: true },
          { kind: "action", id: "mi2", label: "Item 2", actionRef: "a2", enabled: true },
        ],
      },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Меню из 2 пункт(ов).");
  });

  it("describes mouseAction", () => {
    const action = makeAction({
      type: "mouseAction",
      payload: { action: "doubleClick" },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Мышь: Двойной клик");
  });

  it("describes mouseAction with unknown kind shows raw value", () => {
    const action = makeAction({
      type: "mouseAction",
      payload: { action: "unknownKind" as never },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Мышь: unknownKind");
  });

  it("describes mediaKey action", () => {
    const action = makeAction({
      type: "mediaKey",
      payload: { key: "playPause" },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Медиа: Play / Pause");
  });

  it("describes mediaKey with unknown key shows raw value", () => {
    const action = makeAction({
      type: "mediaKey",
      payload: { key: "unknownKey" as never },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Медиа: unknownKey");
  });

  it("describes profileSwitch action", () => {
    const action = makeAction({
      type: "profileSwitch",
      payload: { targetProfileId: "p2" },
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Профиль: p2");
  });

  it("describes disabled action with notes", () => {
    const action = makeAction({
      type: "disabled",
      payload: {},
      notes: "Custom disable note",
    });
    expect(describeActionSummary(action, emptySnippets)).toBe("Custom disable note");
  });

  it("describes disabled action without notes", () => {
    const action = makeAction({
      type: "disabled",
      payload: {},
    });
    expect(describeActionSummary(action, emptySnippets)).toBe(
      "Отключённое действие-заглушка.",
    );
  });
});

// ---------------------------------------------------------------------------
// isActionLiveRunnable
// ---------------------------------------------------------------------------

describe("isActionLiveRunnable", () => {
  it("returns false when action not found", () => {
    const config = makeConfig();
    expect(isActionLiveRunnable(config, "nonexistent")).toBe(false);
  });

  it("returns true for shortcut with a key", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "shortcut",
          payload: { key: "A", ctrl: true, shift: false, alt: false, win: false },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns false for shortcut without a key", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "shortcut",
          payload: { key: "", ctrl: false, shift: false, alt: false, win: false },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns true for inline textSnippet", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "textSnippet",
          payload: { source: "inline", text: "hi", pasteMode: "clipboardPaste" as PasteMode, tags: [] },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns true for libraryRef textSnippet when snippet exists", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "textSnippet",
          payload: { source: "libraryRef", snippetId: "s1" },
        }),
      ],
      snippetLibrary: [
        { id: "s1", name: "Test", text: "hello", pasteMode: "clipboardPaste", tags: [] },
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns false for libraryRef textSnippet when snippet is missing", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "textSnippet",
          payload: { source: "libraryRef", snippetId: "missing" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns true for sequence with steps", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "sequence",
          payload: { steps: [{ type: "send", value: "Ctrl+C" }] },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns false for sequence with empty steps", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "sequence",
          payload: { steps: [] },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns true for launch with a target", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "launch",
          payload: { target: "C:\\app.exe" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns false for launch without target", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "launch",
          payload: { target: "" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns true for disabled action", () => {
    const config = makeConfig({
      actions: [makeAction({ id: "a1", type: "disabled", payload: {} })],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(true);
  });

  it("returns false for mouseAction (not runnable)", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "mouseAction",
          payload: { action: "leftClick" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns false for mediaKey (not runnable)", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "mediaKey",
          payload: { key: "playPause" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns false for profileSwitch (not runnable)", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "profileSwitch",
          payload: { targetProfileId: "p2" },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });

  it("returns false for menu (not runnable)", () => {
    const config = makeConfig({
      actions: [
        makeAction({
          id: "a1",
          type: "menu",
          payload: { items: [] },
        }),
      ],
    });
    expect(isActionLiveRunnable(config, "a1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withShortcutPayload
// ---------------------------------------------------------------------------

describe("withShortcutPayload", () => {
  it("transforms shortcut action payload", () => {
    const action = makeAction({
      type: "shortcut",
      payload: { key: "A", ctrl: false, shift: false, alt: false, win: false },
    });
    const result = withShortcutPayload(action, (p) => ({ ...p, ctrl: true }));
    expect(result.type).toBe("shortcut");
    if (result.type === "shortcut") {
      expect(result.payload.ctrl).toBe(true);
      expect(result.payload.key).toBe("A");
    }
  });

  it("returns the action unchanged for non-shortcut type", () => {
    const action = makeAction({ type: "disabled", payload: {} });
    const result = withShortcutPayload(action, (p) => ({ ...p, key: "B" }));
    expect(result).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// withTextSnippetPayload
// ---------------------------------------------------------------------------

describe("withTextSnippetPayload", () => {
  it("transforms textSnippet action payload", () => {
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "inline", text: "old", pasteMode: "clipboardPaste" as PasteMode, tags: [] },
    });
    const result = withTextSnippetPayload(action, (p) => {
      if (p.source === "inline") return { ...p, text: "new" };
      return p;
    });
    expect(result.type).toBe("textSnippet");
    if (result.type === "textSnippet" && result.payload.source === "inline") {
      expect(result.payload.text).toBe("new");
    }
  });

  it("returns unchanged for non-textSnippet type", () => {
    const action = makeAction({ type: "disabled", payload: {} });
    const result = withTextSnippetPayload(action, (p) => p);
    expect(result).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// withSequencePayload
// ---------------------------------------------------------------------------

describe("withSequencePayload", () => {
  it("transforms sequence action payload", () => {
    const action = makeAction({
      type: "sequence",
      payload: { steps: [{ type: "send", value: "Ctrl+C" }] },
    });
    const result = withSequencePayload(action, (p) => ({
      ...p,
      steps: [...p.steps, { type: "sleep" as const, delayMs: 200 }],
    }));
    if (result.type === "sequence") {
      expect(result.payload.steps).toHaveLength(2);
    }
  });

  it("returns unchanged for non-sequence type", () => {
    const action = makeAction({ type: "disabled", payload: {} });
    const result = withSequencePayload(action, (p) => p);
    expect(result).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// withLaunchPayload
// ---------------------------------------------------------------------------

describe("withLaunchPayload", () => {
  it("transforms launch action payload", () => {
    const action = makeAction({
      type: "launch",
      payload: { target: "old.exe" },
    });
    const result = withLaunchPayload(action, (p) => ({ ...p, target: "new.exe" }));
    if (result.type === "launch") {
      expect(result.payload.target).toBe("new.exe");
    }
  });

  it("returns unchanged for non-launch type", () => {
    const action = makeAction({ type: "disabled", payload: {} });
    const result = withLaunchPayload(action, (p) => p);
    expect(result).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// withMenuPayload
// ---------------------------------------------------------------------------

describe("withMenuPayload", () => {
  it("transforms menu action payload", () => {
    const action = makeAction({
      type: "menu",
      payload: { items: [] },
    });
    const result = withMenuPayload(action, (p) => ({
      ...p,
      items: [{ kind: "action" as const, id: "mi1", label: "New", actionRef: "a1", enabled: true }],
    }));
    if (result.type === "menu") {
      expect(result.payload.items).toHaveLength(1);
    }
  });

  it("returns unchanged for non-menu type", () => {
    const action = makeAction({ type: "disabled", payload: {} });
    const result = withMenuPayload(action, (p) => p);
    expect(result).toBe(action);
  });
});

// ---------------------------------------------------------------------------
// createDefaultSequenceStep
// ---------------------------------------------------------------------------

describe("createDefaultSequenceStep", () => {
  it("creates default send step", () => {
    const step = createDefaultSequenceStep("send");
    expect(step).toEqual({ type: "send", value: "Ctrl+C" });
  });

  it("creates default text step", () => {
    const step = createDefaultSequenceStep("text");
    expect(step).toEqual({ type: "text", value: "Замените этот текст" });
  });

  it("creates default sleep step", () => {
    const step = createDefaultSequenceStep("sleep");
    expect(step).toEqual({ type: "sleep", delayMs: 100 });
  });

  it("creates default launch step", () => {
    const step = createDefaultSequenceStep("launch");
    expect(step).toEqual({ type: "launch", value: "C:\\Путь\\К\\Программе.exe" });
  });
});

// ---------------------------------------------------------------------------
// coerceSequenceStepType
// ---------------------------------------------------------------------------

describe("coerceSequenceStepType", () => {
  it("returns same step when type matches (no-op)", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C" };
    expect(coerceSequenceStepType(step, "send")).toBe(step);
  });

  it("converts send to text preserving value", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C", delayMs: 50 };
    const result = coerceSequenceStepType(step, "text");
    expect(result).toEqual({ type: "text", value: "Ctrl+C", delayMs: 50 });
  });

  it("converts text to send preserving value", () => {
    const step: SequenceStep = { type: "text", value: "hello" };
    const result = coerceSequenceStepType(step, "send");
    expect(result).toEqual({ type: "send", value: "hello", delayMs: undefined });
  });

  it("converts send to sleep using existing delayMs", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C", delayMs: 300 };
    const result = coerceSequenceStepType(step, "sleep");
    expect(result).toEqual({ type: "sleep", delayMs: 300 });
  });

  it("converts send to sleep with default 100 when no delayMs", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C" };
    const result = coerceSequenceStepType(step, "sleep");
    expect(result).toEqual({ type: "sleep", delayMs: 100 });
  });

  it("converts sleep to send with default value", () => {
    const step: SequenceStep = { type: "sleep", delayMs: 500 };
    const result = coerceSequenceStepType(step, "send");
    expect(result).toEqual({ type: "send", value: "Ctrl+C", delayMs: 500 });
  });

  it("converts send to launch preserving value", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C", delayMs: 50 };
    const result = coerceSequenceStepType(step, "launch");
    expect(result).toEqual({
      type: "launch",
      value: "Ctrl+C",
      args: undefined,
      workingDir: undefined,
      delayMs: 50,
    });
  });

  it("converts launch to launch preserving args and workingDir", () => {
    const step: SequenceStep = {
      type: "launch",
      value: "app.exe",
      args: ["--flag"],
      workingDir: "C:\\dir",
      delayMs: 10,
    };
    const result = coerceSequenceStepType(step, "launch");
    expect(result).toBe(step); // same type, no-op
  });

  it("converts text to launch losing args/workingDir", () => {
    const step: SequenceStep = { type: "text", value: "some text" };
    const result = coerceSequenceStepType(step, "launch");
    expect(result).toEqual({
      type: "launch",
      value: "some text",
      args: undefined,
      workingDir: undefined,
      delayMs: undefined,
    });
  });

  it("converts sleep to launch with default value", () => {
    const step: SequenceStep = { type: "sleep", delayMs: 200 };
    const result = coerceSequenceStepType(step, "launch");
    expect(result).toEqual({
      type: "launch",
      value: "C:\\Путь\\К\\Программе.exe",
      args: undefined,
      workingDir: undefined,
      delayMs: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// setSequenceStepDelay
// ---------------------------------------------------------------------------

describe("setSequenceStepDelay", () => {
  it("sets delay on sleep step (always has delay, defaults to 100)", () => {
    const step: SequenceStep = { type: "sleep", delayMs: 500 };
    const result = setSequenceStepDelay(step, 250);
    expect(result).toEqual({ type: "sleep", delayMs: 250 });
  });

  it("defaults sleep delay to 100 when undefined", () => {
    const step: SequenceStep = { type: "sleep", delayMs: 500 };
    const result = setSequenceStepDelay(step, undefined);
    expect(result).toEqual({ type: "sleep", delayMs: 100 });
  });

  it("sets optional delay on send step", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C" };
    const result = setSequenceStepDelay(step, 300);
    expect(result).toEqual({ type: "send", value: "Ctrl+C", delayMs: 300 });
  });

  it("clears delay on non-sleep step when undefined", () => {
    const step: SequenceStep = { type: "text", value: "hello", delayMs: 200 };
    const result = setSequenceStepDelay(step, undefined);
    expect(result).toEqual({ type: "text", value: "hello", delayMs: undefined });
  });

  it("sets delay on launch step", () => {
    const step: SequenceStep = { type: "launch", value: "app.exe" };
    const result = setSequenceStepDelay(step, 150);
    expect(result).toEqual({ type: "launch", value: "app.exe", delayMs: 150 });
  });
});
