import { describe, it, expect } from "vitest";
import type {
  Action,
  AppConfig,
  AppMapping,
  Binding,
  ControlId,
  MenuItem,
  PasteMode,
  PhysicalControl,
  SequenceStep,
  SnippetLibraryItem,
} from "./config";
import type { VerificationStepResult } from "./verification-session";
import type { ViewState } from "./constants";
import {
  resolveInitialProfileId,
  resolveInitialControlId,
  sortAppMappings,
  parseCommaSeparatedUniqueValues,
  parseCommaSeparatedList,
  parseOptionalNumber,
} from "./helpers";
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
import {
  collectMenuItemIds,
  appendMenuItem,
  updateMenuItem,
  removeMenuItem,
} from "./menu-helpers";
import {
  describeVerificationAlignment,
  describeVerificationSessionSuggestion,
  dotLabel,
  verificationResultColor,
} from "./verification-helpers";

// ---------------------------------------------------------------------------
// Helpers to build minimal fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    settings: {
      fallbackProfileId: "p1",
      theme: "dark",
      startWithWindows: false,
      minimizeToTray: false,
      debugLogging: false,
    },
    profiles: [
      { id: "p1", name: "Default", enabled: true, priority: 0 },
      { id: "p2", name: "Gaming", enabled: true, priority: 1 },
    ],
    physicalControls: [
      {
        id: "mouse_4",
        family: "topPanel",
        defaultName: "Mouse 4",
        remappable: true,
        capabilityStatus: "verified",
      },
      {
        id: "thumb_01",
        family: "thumbGrid",
        defaultName: "Thumb 1",
        remappable: true,
        capabilityStatus: "verified",
      },
    ] as PhysicalControl[],
    encoderMappings: [],
    appMappings: [],
    bindings: [],
    actions: [],
    snippetLibrary: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<Action> & Pick<Action, "type" | "payload">): Action {
  return {
    id: "a1",
    pretty: "Test Action",
    ...overrides,
  } as Action;
}

function makeSnippetMap(items: SnippetLibraryItem[]): Map<string, SnippetLibraryItem> {
  return new Map(items.map((s) => [s.id, s]));
}

const emptySnippets = new Map<string, SnippetLibraryItem>();

// ---------------------------------------------------------------------------
// resolveInitialProfileId
// ---------------------------------------------------------------------------

describe("resolveInitialProfileId", () => {
  it("returns the fallback profile id when it exists in profiles", () => {
    const config = makeConfig();
    expect(resolveInitialProfileId(config)).toBe("p1");
  });

  it("falls back to the first profile when fallback id does not match", () => {
    const config = makeConfig({
      settings: {
        fallbackProfileId: "nonexistent",
        theme: "dark",
        startWithWindows: false,
        minimizeToTray: false,
        debugLogging: false,
      },
    });
    expect(resolveInitialProfileId(config)).toBe("p1");
  });

  it("returns null when profiles array is empty", () => {
    const config = makeConfig({ profiles: [] });
    expect(resolveInitialProfileId(config)).toBeNull();
  });

  it("returns the first profile id when fallback profile is missing and profiles exist", () => {
    const config = makeConfig({
      settings: {
        fallbackProfileId: "missing",
        theme: "dark",
        startWithWindows: false,
        minimizeToTray: false,
        debugLogging: false,
      },
      profiles: [{ id: "only", name: "Only", enabled: true, priority: 0 }],
    });
    expect(resolveInitialProfileId(config)).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// resolveInitialControlId
// ---------------------------------------------------------------------------

describe("resolveInitialControlId", () => {
  it("returns the first thumbGrid control", () => {
    const config = makeConfig();
    expect(resolveInitialControlId(config)).toBe("thumb_01");
  });

  it("returns the first control when no thumbGrid exists", () => {
    const config = makeConfig({
      physicalControls: [
        {
          id: "mouse_4",
          family: "topPanel",
          defaultName: "Mouse 4",
          remappable: true,
          capabilityStatus: "verified",
        },
      ] as PhysicalControl[],
    });
    expect(resolveInitialControlId(config)).toBe("mouse_4");
  });

  it("returns null when controls are empty", () => {
    const config = makeConfig({ physicalControls: [] });
    expect(resolveInitialControlId(config)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sortAppMappings
// ---------------------------------------------------------------------------

describe("sortAppMappings", () => {
  it("sorts by priority descending", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "a.exe", profileId: "p1", enabled: true, priority: 1 },
      { id: "m2", exe: "b.exe", profileId: "p1", enabled: true, priority: 10 },
      { id: "m3", exe: "c.exe", profileId: "p1", enabled: true, priority: 5 },
    ];
    const sorted = sortAppMappings(mappings);
    expect(sorted.map((m) => m.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("uses exe name ascending as tiebreaker", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "zoo.exe", profileId: "p1", enabled: true, priority: 5 },
      { id: "m2", exe: "alpha.exe", profileId: "p1", enabled: true, priority: 5 },
      { id: "m3", exe: "mid.exe", profileId: "p1", enabled: true, priority: 5 },
    ];
    const sorted = sortAppMappings(mappings);
    expect(sorted.map((m) => m.exe)).toEqual(["alpha.exe", "mid.exe", "zoo.exe"]);
  });

  it("does not mutate the original array", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "b.exe", profileId: "p1", enabled: true, priority: 2 },
      { id: "m2", exe: "a.exe", profileId: "p1", enabled: true, priority: 1 },
    ];
    const original = [...mappings];
    sortAppMappings(mappings);
    expect(mappings).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// parseCommaSeparatedUniqueValues
// ---------------------------------------------------------------------------

describe("parseCommaSeparatedUniqueValues", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparatedUniqueValues("one,two,three")).toEqual(["one", "two", "three"]);
  });

  it("removes duplicates", () => {
    expect(parseCommaSeparatedUniqueValues("a, a, b")).toEqual(["a", "b"]);
  });

  it("filters out empty strings", () => {
    expect(parseCommaSeparatedUniqueValues("a,,b")).toEqual(["a", "b"]);
  });

  it("trims whitespace from values", () => {
    expect(parseCommaSeparatedUniqueValues("  x , y , z  ")).toEqual(["x", "y", "z"]);
  });

  it("handles all-empty input", () => {
    expect(parseCommaSeparatedUniqueValues(",,")).toEqual([]);
  });

  it("handles a single empty string", () => {
    expect(parseCommaSeparatedUniqueValues("")).toEqual([]);
  });

  it("preserves order of first appearance for duplicates", () => {
    expect(parseCommaSeparatedUniqueValues("c,b,a,b,c")).toEqual(["c", "b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// parseCommaSeparatedList
// ---------------------------------------------------------------------------

describe("parseCommaSeparatedList", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparatedList("one,two,three")).toEqual(["one", "two", "three"]);
  });

  it("keeps duplicates (unlike unique version)", () => {
    expect(parseCommaSeparatedList("a,a,b")).toEqual(["a", "a", "b"]);
  });

  it("filters out empty strings", () => {
    expect(parseCommaSeparatedList("a,,b")).toEqual(["a", "b"]);
  });

  it("trims whitespace", () => {
    expect(parseCommaSeparatedList("  x , y ")).toEqual(["x", "y"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseCommaSeparatedList("")).toEqual([]);
  });

  it("returns empty array for whitespace-only segments", () => {
    expect(parseCommaSeparatedList(" , , ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOptionalNumber
// ---------------------------------------------------------------------------

describe("parseOptionalNumber", () => {
  it("returns a number for valid numeric strings", () => {
    expect(parseOptionalNumber("42")).toBe(42);
  });

  it("returns undefined for empty string", () => {
    expect(parseOptionalNumber("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseOptionalNumber("   ")).toBeUndefined();
  });

  it("returns undefined for NaN-producing strings", () => {
    expect(parseOptionalNumber("abc")).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    expect(parseOptionalNumber("Infinity")).toBeUndefined();
  });

  it("returns undefined for -Infinity", () => {
    expect(parseOptionalNumber("-Infinity")).toBeUndefined();
  });

  it("handles -0 as a finite number", () => {
    expect(parseOptionalNumber("-0")).toBe(-0);
  });

  it("handles scientific notation", () => {
    expect(parseOptionalNumber("1e3")).toBe(1000);
  });

  it("returns undefined for malformed decimals like 1.5.2", () => {
    expect(parseOptionalNumber("1.5.2")).toBeUndefined();
  });

  it("handles negative numbers", () => {
    expect(parseOptionalNumber("-5")).toBe(-5);
  });

  it("handles floating point numbers", () => {
    expect(parseOptionalNumber("3.14")).toBeCloseTo(3.14);
  });
});

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
// describeVerificationAlignment
// ---------------------------------------------------------------------------

describe("describeVerificationAlignment", () => {
  it("returns info notice when neither expected nor configured", () => {
    const result = describeVerificationAlignment(null, null, null, false);
    expect(result.noticeClass).toBe("notice--info");
    expect(result.title).toContain("не задан");
  });

  it("returns warning when expected exists but configured is missing", () => {
    const result = describeVerificationAlignment("key1", null, null, false);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("key1");
  });

  it("returns warning when expected and configured mismatch", () => {
    const result = describeVerificationAlignment("expected", "configured", null, false);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("expected");
    expect(result.body).toContain("configured");
  });

  it("returns ok when observed matches configured and matches selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "key1", true);
    expect(result.noticeClass).toBe("notice--ok");
    expect(result.body).toContain("key1");
  });

  it("returns warning when observed differs from configured but matches selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "other", true);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("other");
    expect(result.body).toContain("key1");
  });

  it("returns subtle when configured exists but no observation yet", () => {
    const result = describeVerificationAlignment("key1", "key1", null, false);
    expect(result.noticeClass).toBe("notice--subtle");
    expect(result.title).toContain("готов");
  });

  it("returns subtle when configured exists and observed does not match selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "key1", false);
    expect(result.noticeClass).toBe("notice--subtle");
  });
});

// ---------------------------------------------------------------------------
// describeVerificationSessionSuggestion
// ---------------------------------------------------------------------------

describe("describeVerificationSessionSuggestion", () => {
  const baseStep = {
    controlId: "thumb_01" as ControlId,
    controlLabel: "Thumb 1",
    family: "thumbGrid" as const,
    layer: "standard" as const,
    capabilityStatus: "verified" as const,
    expectedEncodedKey: "key1",
    configuredEncodedKey: "key1",
    startedAt: 1000,
    observedEncodedKey: null as string | null,
    observedAt: null as number | null,
    observedBackend: null as string | null,
    activeExe: null as string | null,
    activeWindowTitle: null as string | null,
    resolutionStatus: null as null,
    resolvedControlId: null as ControlId | null,
    resolvedLayer: null as null,
    result: "pending" as VerificationStepResult,
    notes: "",
  };

  it("returns matched suggestion when observed key is present", () => {
    const step = { ...baseStep, observedEncodedKey: "key1" };
    const result = describeVerificationSessionSuggestion("matched", step);
    expect(result).toContain("key1");
    expect(result).toContain("совпал");
  });

  it("returns mismatched suggestion with observed key", () => {
    const step = { ...baseStep, observedEncodedKey: "wrong" };
    const result = describeVerificationSessionSuggestion("mismatched", step);
    expect(result).toContain("wrong");
  });

  it("returns mismatched suggestion without observed key", () => {
    const result = describeVerificationSessionSuggestion("mismatched", baseStep);
    expect(result).toContain("не дало чистого совпадения");
  });

  it("returns noSignal suggestion", () => {
    const result = describeVerificationSessionSuggestion("noSignal", baseStep);
    expect(result).toContain("не увидело нового сигнала");
  });

  it("returns skipped suggestion", () => {
    const result = describeVerificationSessionSuggestion("skipped", baseStep);
    expect(result).toContain("пропущен");
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

// ---------------------------------------------------------------------------
// collectMenuItemIds
// ---------------------------------------------------------------------------

describe("collectMenuItemIds", () => {
  it("collects ids from a flat list", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
    ];
    expect(collectMenuItemIds(items)).toEqual(["a", "b"]);
  });

  it("collects ids from nested submenus", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
        ],
      },
    ];
    expect(collectMenuItemIds(items)).toEqual(["a", "sub", "b"]);
  });

  it("collects ids from deeply nested submenus", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [
              { kind: "action", id: "deep", label: "Deep", actionRef: "r1", enabled: true },
            ],
          },
        ],
      },
    ];
    expect(collectMenuItemIds(items)).toEqual(["s1", "s2", "deep"]);
  });

  it("returns empty array for empty items", () => {
    expect(collectMenuItemIds([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendMenuItem
// ---------------------------------------------------------------------------

describe("appendMenuItem", () => {
  const newItem: MenuItem = {
    kind: "action",
    id: "new",
    label: "New",
    actionRef: "r1",
    enabled: true,
  };

  it("appends to root level when parentId is null", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = appendMenuItem(items, null, newItem);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe("new");
  });

  it("appends into a submenu by parentId", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [{ kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true }],
      },
    ];
    const result = appendMenuItem(items, "sub", newItem);
    if (result[0].kind === "submenu") {
      expect(result[0].items).toHaveLength(2);
      expect(result[0].items[1].id).toBe("new");
    }
  });

  it("appends into a nested submenu", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [],
          },
        ],
      },
    ];
    const result = appendMenuItem(items, "s2", newItem);
    if (result[0].kind === "submenu" && result[0].items[0].kind === "submenu") {
      expect(result[0].items[0].items).toHaveLength(1);
      expect(result[0].items[0].items[0].id).toBe("new");
    }
  });

  it("does not crash when parentId does not exist", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = appendMenuItem(items, "nonexistent", newItem);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("does not mutate original items", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const original = [...items];
    appendMenuItem(items, null, newItem);
    expect(items).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// updateMenuItem
// ---------------------------------------------------------------------------

describe("updateMenuItem", () => {
  it("updates a root-level item", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "Old", actionRef: "r1", enabled: true },
    ];
    const result = updateMenuItem(items, "a", (item) =>
      item.kind === "action" ? { ...item, label: "New" } : item,
    );
    expect(result[0].kind === "action" && result[0].label).toBe("New");
  });

  it("updates a nested item", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "a", label: "Old", actionRef: "r1", enabled: true },
        ],
      },
    ];
    const result = updateMenuItem(items, "a", (item) =>
      item.kind === "action" ? { ...item, label: "Updated" } : item,
    );
    if (result[0].kind === "submenu") {
      expect(result[0].items[0].kind === "action" && result[0].items[0].label).toBe("Updated");
    }
  });

  it("returns unchanged items when targetId is not found", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = updateMenuItem(items, "nonexistent", (item) => item);
    expect(result[0].id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// removeMenuItem
// ---------------------------------------------------------------------------

describe("removeMenuItem", () => {
  it("removes a root-level item", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
    ];
    const result = removeMenuItem(items, "a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("removes a nested item", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
          { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
        ],
      },
    ];
    const result = removeMenuItem(items, "a");
    if (result[0].kind === "submenu") {
      expect(result[0].items).toHaveLength(1);
      expect(result[0].items[0].id).toBe("b");
    }
  });

  it("cascades removal of empty submenu after removing last child", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "only", label: "Only", actionRef: "r1", enabled: true },
        ],
      },
    ];
    const result = removeMenuItem(items, "only");
    expect(result).toHaveLength(0);
  });

  it("cascades nested empty submenu removal", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [
              { kind: "action", id: "deep", label: "Deep", actionRef: "r1", enabled: true },
            ],
          },
        ],
      },
    ];
    const result = removeMenuItem(items, "deep");
    // s2 becomes empty -> removed, s1 becomes empty -> removed
    expect(result).toHaveLength(0);
  });

  it("returns unchanged items when targetId not found", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = removeMenuItem(items, "nonexistent");
    expect(result).toHaveLength(1);
  });
});

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
// dotLabel
// ---------------------------------------------------------------------------

describe("dotLabel", () => {
  it("returns numeric label for thumb_01 through thumb_12", () => {
    expect(dotLabel("thumb_01")).toBe("1");
    expect(dotLabel("thumb_02")).toBe("2");
    expect(dotLabel("thumb_10")).toBe("10");
    expect(dotLabel("thumb_11")).toBe("11");
    expect(dotLabel("thumb_12")).toBe("12");
  });

  it("strips leading zero from thumb buttons", () => {
    expect(dotLabel("thumb_09")).toBe("9");
  });

  it("returns correct label for mouse_4", () => {
    expect(dotLabel("mouse_4")).toBe("←");
  });

  it("returns correct label for mouse_5", () => {
    expect(dotLabel("mouse_5")).toBe("→");
  });

  it("returns correct label for wheel_up", () => {
    expect(dotLabel("wheel_up")).toBe("↑");
  });

  it("returns correct label for wheel_down", () => {
    expect(dotLabel("wheel_down")).toBe("↓");
  });

  it("returns correct label for wheel_click", () => {
    expect(dotLabel("wheel_click")).toBe("⊙");
  });

  it("returns correct label for top_aux_01", () => {
    expect(dotLabel("top_aux_01")).toBe("D+");
  });

  it("returns correct label for top_aux_02", () => {
    expect(dotLabel("top_aux_02")).toBe("D−");
  });

  it("returns ? for unknown controls", () => {
    expect(dotLabel("unknown_control")).toBe("?");
  });

  it("returns ? for mouse_left (not in dot label map)", () => {
    expect(dotLabel("mouse_left")).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// verificationResultColor
// ---------------------------------------------------------------------------

describe("verificationResultColor", () => {
  it("returns ok color for matched", () => {
    expect(verificationResultColor("matched")).toBe("var(--c-ok)");
  });

  it("returns danger color for mismatched", () => {
    expect(verificationResultColor("mismatched")).toBe("var(--c-danger)");
  });

  it("returns warning color for noSignal", () => {
    expect(verificationResultColor("noSignal")).toBe("var(--c-warning)");
  });

  it("returns muted color for skipped", () => {
    expect(verificationResultColor("skipped")).toBe("var(--c-text-muted)");
  });

  it("returns border color for pending", () => {
    expect(verificationResultColor("pending")).toBe("var(--c-border)");
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
