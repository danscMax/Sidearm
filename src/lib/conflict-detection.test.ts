import { describe, expect, it } from "vitest";

import type { Action, AppConfig, Binding } from "./config";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
  shortcutSignature,
} from "./conflict-detection";
import { makeConfig } from "./test-fixtures";

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
    displayName: `${mods.ctrl ? "Ctrl+" : ""}${key}`,
  };
}

function binding(
  id: string,
  profileId: string,
  layer: "standard" | "hypershift",
  controlId: string,
  actionId: string,
  enabled = true,
): Binding {
  return {
    id,
    profileId,
    layer,
    controlId: controlId as Binding["controlId"],
    label: "",
    actionId,
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
    devices: [],
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
  it("groups duplicate shortcuts only among buttons of the same device", () => {
    const cfg = makeConfig({
      actions: [shortcutAction("copy", "C", { ctrl: true })],
      bindings: [
        binding("v2-1", "p1", "standard", "thumb_01", "copy"),
        binding("v2-4", "p1", "standard", "mouse_4", "copy"),
        binding("v3-1", "p1", "standard", "v3_thumb_01", "copy"),
      ],
    });
    cfg.devices.push({ id: "razer-naga-v3", name: "Razer Naga V3 Pro", builtin: true });
    cfg.physicalControls.push({
      ...cfg.physicalControls[1],
      id: "v3_thumb_01",
      deviceId: "razer-naga-v3",
    });

    expect(findShortcutConflicts(cfg)).toHaveLength(1);
    expect([...conflictingBindingIds(cfg)]).toEqual(["v2-1", "v2-4"]);
    cfg.bindings = cfg.bindings.filter((entry) => entry.id !== "v2-4");
    expect(findShortcutConflicts(cfg)).toHaveLength(0);
  });

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
      { id: "a1", type: "disabled", payload: {} as never, displayName: "off" },
      { id: "a2", type: "disabled", payload: {} as never, displayName: "off" },
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

  it("matches by action content — launch target and sequence step text", () => {
    const b = binding("b1", "p", "standard", "thumb_01", "a1");
    const launch: Action = {
      id: "a1",
      type: "launch",
      payload: { target: "C:/Tools/code.exe" },
      displayName: "Open editor",
    };
    expect(bindingMatchesQuery(b, launch, "code.exe")).toBe(true);
    expect(bindingMatchesQuery(b, launch, "notepad")).toBe(false);

    const seq: Action = {
      id: "a2",
      type: "sequence",
      payload: { steps: [{ type: "send", value: "git push" }] },
      displayName: "Push",
    };
    expect(bindingMatchesQuery(b, seq, "git push")).toBe(true);
  });

  it("matches against action.displayName", () => {
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
