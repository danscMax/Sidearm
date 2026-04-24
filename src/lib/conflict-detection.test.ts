import { describe, expect, it } from "vitest";

import type { Action, AppConfig, Binding } from "./config";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
  shortcutSignature,
} from "./conflict-detection";

function shortcutAction(
  id: string,
  key: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; win: boolean }> = {},
): Action {
  return {
    id,
    type: "shortcut",
    payload: {
      key,
      ctrl: mods.ctrl ?? false,
      shift: mods.shift ?? false,
      alt: mods.alt ?? false,
      win: mods.win ?? false,
    },
    pretty: `${mods.ctrl ? "Ctrl+" : ""}${key}`,
  };
}

function binding(
  id: string,
  profileId: string,
  layer: "standard" | "hypershift",
  controlId: string,
  actionRef: string,
  enabled = true,
): Binding {
  return {
    id,
    profileId,
    layer,
    controlId: controlId as Binding["controlId"],
    label: "",
    actionRef,
    enabled,
  };
}

function config(actions: Action[], bindings: Binding[]): AppConfig {
  return {
    version: 2,
    settings: {
      fallbackProfileId: "default",
      theme: "synapse-light",
      startWithWindows: true,
      minimizeToTray: true,
      debugLogging: true,
    } as AppConfig["settings"],
    profiles: [],
    physicalControls: [],
    encoderMappings: [],
    appMappings: [],
    bindings,
    actions,
    snippetLibrary: [],
  };
}

describe("shortcutSignature", () => {
  it("uppercases the key", () => {
    expect(
      shortcutSignature({ key: "a", ctrl: true, shift: false, alt: false, win: false }),
    ).toBe("Ctrl+A");
  });

  it("orders modifiers consistently", () => {
    const a = shortcutSignature({ key: "C", ctrl: true, shift: true, alt: false, win: false });
    const b = shortcutSignature({ key: "c", ctrl: true, shift: true, alt: false, win: false });
    expect(a).toBe(b);
    expect(a).toBe("Ctrl+Shift+C");
  });

  it("returns empty string for empty key", () => {
    expect(
      shortcutSignature({ key: "", ctrl: true, shift: false, alt: false, win: false }),
    ).toBe("");
  });
});

describe("findShortcutConflicts", () => {
  it("detects two bindings with the same shortcut", () => {
    const actions = [
      shortcutAction("a1", "C", { ctrl: true }),
      shortcutAction("a2", "C", { ctrl: true }),
    ];
    const bindings = [
      binding("b1", "p", "standard", "thumb_01", "a1"),
      binding("b2", "p", "standard", "thumb_02", "a2"),
    ];
    const groups = findShortcutConflicts(config(actions, bindings));
    expect(groups).toHaveLength(1);
    expect(groups[0].bindings).toHaveLength(2);
  });

  it("does not flag different layers as conflicts", () => {
    const actions = [
      shortcutAction("a1", "C", { ctrl: true }),
      shortcutAction("a2", "C", { ctrl: true }),
    ];
    const bindings = [
      binding("b1", "p", "standard", "thumb_01", "a1"),
      binding("b2", "p", "hypershift", "thumb_01", "a2"),
    ];
    expect(findShortcutConflicts(config(actions, bindings))).toHaveLength(0);
  });

  it("does not flag different profiles as conflicts", () => {
    const actions = [
      shortcutAction("a1", "C", { ctrl: true }),
      shortcutAction("a2", "C", { ctrl: true }),
    ];
    const bindings = [
      binding("b1", "p1", "standard", "thumb_01", "a1"),
      binding("b2", "p2", "standard", "thumb_01", "a2"),
    ];
    expect(findShortcutConflicts(config(actions, bindings))).toHaveLength(0);
  });

  it("ignores disabled bindings", () => {
    const actions = [
      shortcutAction("a1", "C", { ctrl: true }),
      shortcutAction("a2", "C", { ctrl: true }),
    ];
    const bindings = [
      binding("b1", "p", "standard", "thumb_01", "a1"),
      binding("b2", "p", "standard", "thumb_02", "a2", false),
    ];
    expect(findShortcutConflicts(config(actions, bindings))).toHaveLength(0);
  });

  it("ignores non-shortcut actions", () => {
    const actions: Action[] = [
      { id: "a1", type: "disabled", payload: {} as never, pretty: "off" },
      { id: "a2", type: "disabled", payload: {} as never, pretty: "off" },
    ];
    const bindings = [
      binding("b1", "p", "standard", "thumb_01", "a1"),
      binding("b2", "p", "standard", "thumb_02", "a2"),
    ];
    expect(findShortcutConflicts(config(actions, bindings))).toHaveLength(0);
  });
});

describe("conflictingBindingIds", () => {
  it("flattens conflict groups into a quick-lookup set", () => {
    const actions = [
      shortcutAction("a1", "F", { ctrl: true }),
      shortcutAction("a2", "F", { ctrl: true }),
      shortcutAction("a3", "X"), // unique, no conflict
    ];
    const bindings = [
      binding("b1", "p", "standard", "thumb_01", "a1"),
      binding("b2", "p", "standard", "thumb_02", "a2"),
      binding("b3", "p", "standard", "thumb_03", "a3"),
    ];
    const ids = conflictingBindingIds(config(actions, bindings));
    expect(ids.has("b1")).toBe(true);
    expect(ids.has("b2")).toBe(true);
    expect(ids.has("b3")).toBe(false);
  });
});

describe("bindingMatchesQuery", () => {
  it("matches empty query against anything", () => {
    const b = binding("b1", "p", "standard", "thumb_01", "a1");
    expect(bindingMatchesQuery(b, null, "")).toBe(true);
  });

  it("matches against label", () => {
    const b = { ...binding("b1", "p", "standard", "thumb_01", "a1"), label: "Copy line" };
    expect(bindingMatchesQuery(b, null, "copy")).toBe(true);
    expect(bindingMatchesQuery(b, null, "paste")).toBe(false);
  });

  it("matches against action.pretty", () => {
    const b = binding("b1", "p", "standard", "thumb_01", "a1");
    const a = shortcutAction("a1", "C", { ctrl: true });
    expect(bindingMatchesQuery(b, a, "ctrl+c")).toBe(true);
  });

  it("matches against canonical shortcut signature", () => {
    const b = binding("b1", "p", "standard", "thumb_01", "a1");
    const a = shortcutAction("a1", "V", { ctrl: true });
    expect(bindingMatchesQuery(b, a, "ctrl+v")).toBe(true);
    expect(bindingMatchesQuery(b, a, "Ctrl+V")).toBe(true);
  });
});
