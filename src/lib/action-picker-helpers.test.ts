import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import type { Binding, Profile } from "./config";
import { makeAction } from "./test-fixtures";
import {
  autoName,
  buildAction,
  createInitialDrafts,
  isSaveDisabled,
  normalizeKeyName,
  resolveKeyName,
  type PickerDrafts,
} from "./action-picker-helpers";

// Identity translate stub — returns the key so tests can assert which i18n key
// would be used (same pattern as errors.test.ts).
const t = ((key: string) => key) as unknown as TFunction;

const profiles: Profile[] = [
  { id: "p1", name: "Gaming", enabled: true, priority: 0 },
  { id: "p2", name: "Work", enabled: true, priority: 1 },
];

function makeDrafts(overrides: Partial<PickerDrafts> = {}): PickerDrafts {
  return {
    shortcut: { key: "", ctrl: false, shift: false, alt: false, win: false },
    mouse: { action: "leftClick", ctrl: false, shift: false, alt: false, win: false },
    text: { text: "", pasteMode: "sendText" },
    launch: { target: "", args: [], workingDir: "" },
    media: "playPause",
    profile: "p1",
    sequence: [{ type: "send", value: "Ctrl+C" }],
    menuItems: [],
    name: "",
    conditions: [],
    ...overrides,
  };
}

describe("resolveKeyName", () => {
  function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
    return { key: "", code: "", keyCode: 0, ...partial } as KeyboardEvent;
  }

  it("returns event.key when present and identified", () => {
    expect(resolveKeyName(ev({ key: "A" }))).toBe("A");
  });

  it("falls back to event.code when key is Unidentified", () => {
    expect(resolveKeyName(ev({ key: "Unidentified", code: "F13" }))).toBe("F13");
  });

  it("maps keyCode 124-135 to F13-F24 when key and code are empty", () => {
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 124 }))).toBe("F13");
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 135 }))).toBe("F24");
  });

  it("emits VK_<code> for other positive keyCodes", () => {
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 200 }))).toBe("VK_200");
  });

  it("returns Unknown when nothing resolves", () => {
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 0 }))).toBe("Unknown");
  });
});

describe("normalizeKeyName", () => {
  it("maps named keys via the table", () => {
    expect(normalizeKeyName(" ")).toBe("Space");
    expect(normalizeKeyName("Escape")).toBe("Esc");
    expect(normalizeKeyName("ArrowUp")).toBe("Up");
  });

  it("uppercases single characters", () => {
    expect(normalizeKeyName("a")).toBe("A");
  });

  it("leaves multi-char unmapped keys untouched", () => {
    expect(normalizeKeyName("F13")).toBe("F13");
  });
});

describe("autoName", () => {
  it("joins modifiers and key for shortcut, falls back to key otherwise", () => {
    const named = autoName(
      "shortcut",
      makeDrafts({ shortcut: { key: "C", ctrl: false, shift: false, alt: false, win: false } }),
      t,
      profiles,
    );
    expect(named).toContain("C");
    const empty = autoName("shortcut", makeDrafts(), t, profiles);
    expect(empty).toBe("picker.autoShortcut");
  });

  it("uses first 30 chars of text, else the auto key", () => {
    expect(autoName("textSnippet", makeDrafts({ text: { text: "hello", pasteMode: "sendText" } }), t, profiles)).toBe("hello");
    expect(autoName("textSnippet", makeDrafts(), t, profiles)).toBe("picker.autoText");
  });

  it("derives launch name from the executable basename", () => {
    expect(
      autoName("launch", makeDrafts({ launch: { target: "C:\\Program Files\\app.exe", args: [], workingDir: "" } }), t, profiles),
    ).toBe("app.exe");
  });

  it("looks up the profile name for profileSwitch (uses passed profiles)", () => {
    expect(autoName("profileSwitch", makeDrafts({ profile: "p2" }), t, profiles)).toBe("picker.autoProfile");
    expect(autoName("profileSwitch", makeDrafts({ profile: "missing" }), t, profiles)).toBe("picker.autoProfileFallback");
  });

  it("uses the action.type label for repairClipboard", () => {
    expect(autoName("repairClipboard", makeDrafts(), t, profiles)).toBe("action.type.repairClipboard");
  });
});

describe("buildAction", () => {
  it("preserves the existing action id and uses the explicit name", () => {
    const existing = makeAction({ type: "shortcut", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } });
    const action = buildAction({
      effectiveCategory: "shortcut",
      existingAction: existing,
      drafts: makeDrafts({ name: "  My Shortcut  ", shortcut: { key: "C", ctrl: true, shift: false, alt: false, win: false } }),
      t,
      profiles,
    });
    expect(action.id).toBe(existing.id);
    expect(action.type).toBe("shortcut");
    expect(action.displayName).toBe("My Shortcut");
  });

  it("generates an action-picker id when there is no existing action", () => {
    const action = buildAction({
      effectiveCategory: "shortcut",
      existingAction: null,
      drafts: makeDrafts({ shortcut: { key: "X", ctrl: false, shift: false, alt: false, win: false } }),
      t,
      profiles,
    });
    expect(action.id.startsWith("action-picker-")).toBe(true);
  });

  it("only includes truthy mouse modifiers in the payload", () => {
    const action = buildAction({
      effectiveCategory: "mouseAction",
      existingAction: null,
      drafts: makeDrafts({ mouse: { action: "doubleClick", ctrl: true, shift: false, alt: true, win: false } }),
      t,
      profiles,
    });
    expect(action.type).toBe("mouseAction");
    if (action.type === "mouseAction") {
      expect(action.payload).toEqual({ action: "doubleClick", ctrl: true, alt: true });
    }
  });

  it("preserves inline textSnippet tags while replacing the text", () => {
    const existing = makeAction({
      type: "textSnippet",
      payload: { source: "inline", text: "old", pasteMode: "sendText", tags: ["keep"] },
    });
    const action = buildAction({
      effectiveCategory: "textSnippet",
      existingAction: existing,
      drafts: makeDrafts({ text: { text: "new text", pasteMode: "clipboardPaste" } }),
      t,
      profiles,
    });
    expect(action.type).toBe("textSnippet");
    if (action.type === "textSnippet" && action.payload.source === "inline") {
      expect(action.payload.text).toBe("new text");
      expect(action.payload.pasteMode).toBe("clipboardPaste");
      expect(action.payload.tags).toEqual(["keep"]);
    }
  });

  it("builds a repairClipboard action with the required latin1 strategy", () => {
    const action = buildAction({
      effectiveCategory: "repairClipboard",
      existingAction: null,
      drafts: makeDrafts(),
      t,
      profiles,
    });
    expect(action.type).toBe("repairClipboard");
    if (action.type === "repairClipboard") {
      expect(action.payload).toEqual({ strategy: "latin1" });
    }
  });

  it("drops empty args/workingDir for launch", () => {
    const action = buildAction({
      effectiveCategory: "launch",
      existingAction: null,
      drafts: makeDrafts({ launch: { target: "app.exe", args: [], workingDir: "   " } }),
      t,
      profiles,
    });
    if (action.type === "launch") {
      expect(action.payload.args).toBeUndefined();
      expect(action.payload.workingDir).toBeUndefined();
    }
  });

  it("filters blank conditions and keeps the non-blank ones", () => {
    const action = buildAction({
      effectiveCategory: "shortcut",
      existingAction: null,
      drafts: makeDrafts({
        shortcut: { key: "A", ctrl: false, shift: false, alt: false, win: false },
        conditions: [
          { type: "exeEquals", value: "game.exe" },
          { type: "windowTitleContains", value: "   " },
        ],
      }),
      t,
      profiles,
    });
    expect(action.conditions).toEqual([{ type: "exeEquals", value: "game.exe" }]);
  });

  it("falls back to a default display name for menu actions with no name", () => {
    const action = buildAction({
      effectiveCategory: "menu",
      existingAction: null,
      drafts: makeDrafts({ name: "" }),
      t,
      profiles,
    });
    expect(action.type).toBe("menu");
    expect(action.displayName).toBe("picker.defaultMenu");
  });
});

describe("createInitialDrafts", () => {
  it("seeds sensible defaults for a brand-new action", () => {
    const initial = createInitialDrafts(null, null, profiles);
    expect(initial.shortcut).toEqual({ key: "", ctrl: false, shift: false, alt: false, win: false });
    expect(initial.mouse.action).toBe("leftClick");
    expect(initial.media).toBe("playPause");
    expect(initial.profile).toBe("p1"); // first profile
    expect(initial.sequence).toEqual([{ type: "send", value: "Ctrl+C" }]);
    expect(initial.name).toBe("");
    expect(initial.conditions).toEqual([]);
    expect(initial.triggerMode).toBe("press");
    expect(initial.chordPartner).toBe("");
  });

  it("falls back to an empty profile id when no profiles exist", () => {
    expect(createInitialDrafts(null, null, []).profile).toBe("");
  });

  it("hydrates from an existing shortcut action and its display name", () => {
    const existing = makeAction({
      type: "shortcut",
      payload: { key: "F5", ctrl: true, shift: false, alt: false, win: false },
    });
    const initial = createInitialDrafts(existing, null, profiles);
    expect(initial.shortcut).toEqual({ key: "F5", ctrl: true, shift: false, alt: false, win: false });
    expect(initial.name).toBe("Test Action");
  });

  it("defaults optional mouse modifiers and launch fields", () => {
    const mouse = createInitialDrafts(
      makeAction({ type: "mouseAction", payload: { action: "rightClick" } }),
      null,
      profiles,
    );
    expect(mouse.mouse).toEqual({ action: "rightClick", ctrl: false, shift: false, alt: false, win: false });

    const launch = createInitialDrafts(
      makeAction({ type: "launch", payload: { target: "app.exe" } }),
      null,
      profiles,
    );
    expect(launch.launch).toEqual({ target: "app.exe", args: [], workingDir: "" });
  });

  it("reads trigger fields from the binding", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "x",
      actionId: "a1",
      enabled: true,
      triggerMode: "hold",
      chordPartner: "thumb_02",
    };
    const initial = createInitialDrafts(null, binding, profiles);
    expect(initial.triggerMode).toBe("hold");
    expect(initial.chordPartner).toBe("thumb_02");
  });
});

describe("isSaveDisabled", () => {
  it("disables save for an empty shortcut, enables once a key or modifier is set", () => {
    expect(isSaveDisabled("shortcut", makeDrafts())).toBe(true);
    expect(isSaveDisabled("shortcut", makeDrafts({ shortcut: { key: "A", ctrl: false, shift: false, alt: false, win: false } }))).toBe(false);
    expect(isSaveDisabled("shortcut", makeDrafts({ shortcut: { key: "", ctrl: true, shift: false, alt: false, win: false } }))).toBe(false);
  });

  it("disables save for blank text, enables with content", () => {
    expect(isSaveDisabled("textSnippet", makeDrafts({ text: { text: "   ", pasteMode: "sendText" } }))).toBe(true);
    expect(isSaveDisabled("textSnippet", makeDrafts({ text: { text: "hi", pasteMode: "sendText" } }))).toBe(false);
  });

  it("disables save for an empty launch target", () => {
    expect(isSaveDisabled("launch", makeDrafts({ launch: { target: "  ", args: [], workingDir: "" } }))).toBe(true);
    expect(isSaveDisabled("launch", makeDrafts({ launch: { target: "app.exe", args: [], workingDir: "" } }))).toBe(false);
  });

  it("never blocks save for categories without required fields", () => {
    expect(isSaveDisabled("mediaKey", makeDrafts())).toBe(false);
    expect(isSaveDisabled("disabled", makeDrafts())).toBe(false);
  });
});
