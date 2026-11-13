import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { checkProfile } from "./config-check";
import { findShortcutConflicts } from "./conflict-detection";
import { makeConfig } from "./test-fixtures";

const key = (id: string, keyName: string, mods: Partial<{ ctrl: boolean; alt: boolean }> = {}): Action =>
  ({ id, type: "shortcut", displayName: id, payload: { key: keyName, ctrl: false, shift: false, alt: false, win: false, ...mods } }) as Action;
const bind = (id: string, controlId: string, actionId: string, extra: Partial<Binding> = {}): Binding =>
  ({ id, profileId: "p1", layer: "standard", controlId, label: id, actionId, enabled: true, ...extra });

describe("checkProfile", () => {
  it("finds broken references in assignments and menus", () => {
    const config = makeConfig({
      actions: [
        { id: "m", type: "menu", displayName: "M", payload: { items: [{ kind: "action", id: "i", label: "Gone", actionId: "nope", enabled: true }] } } as Action,
        { id: "lib", type: "textSnippet", displayName: "L", payload: { source: "libraryRef", snippetId: "deleted" } } as Action,
      ],
      bindings: [bind("b1", "thumb_01", "m"), bind("b2", "mouse_4", "lib"), bind("b3", "thumb_02", "missing")],
    });
    expect(checkProfile(config, "p1").map((issue) => issue.kind).sort()).toEqual(["missingAction", "missingAction", "missingSnippet"]);
  });

  it("warns when Enter and closing the window share a button", () => {
    const config = makeConfig({
      actions: [key("enter", "Enter"), key("close", "F4", { alt: true }), key("other", "A")],
      bindings: [
        bind("b1", "thumb_01", "enter"),
        bind("b2", "thumb_01", "close", { triggerMode: "longPress" }),
        bind("b3", "thumb_02", "close"),
        bind("b4", "thumb_02", "other", { triggerMode: "longPress" }),
      ],
    });
    const issues = checkProfile(config, "p1");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "enterNextToClose", binding: { id: "b2" } });
  });

  it("notes a shortcut on two press patterns; one doubled on the same pattern is a conflict until kept", () => {
    const base = {
      actions: [key("v", "V", { ctrl: true }), key("v2", "V", { ctrl: true })],
      bindings: [bind("b1", "thumb_12", "v"), bind("b2", "thumb_03", "v2", { triggerMode: "longPress" as const }), bind("b3", "thumb_05", "v")],
    };
    // b1 and b3: both plain presses (a conflict, not noted); b2 alone is left.
    expect(checkProfile(makeConfig(base), "p1")).toEqual([]);
    const kept = makeConfig(base);
    kept.settings.acceptedConflicts = [findShortcutConflicts(kept)[0]!.key];
    expect(findShortcutConflicts(kept)).toEqual([]);
    expect(checkProfile(kept, "p1")).toMatchObject([{ kind: "duplicate", bindings: [{ id: "b1" }, { id: "b2" }, { id: "b3" }] }]);
  });

  it("names the same text or shortcut on two buttons of one mouse and layer, not another layer", () => {
    const text = (id: string, value: string): Action =>
      ({ id, type: "textSnippet", displayName: id, payload: { source: "inline", text: value, pasteMode: "sendText", tags: [] } }) as Action;
    const config = makeConfig({
      actions: [text("t1", "hello"), text("t2", "hello"), key("k", "A")],
      bindings: [
        bind("b1", "thumb_01", "t1"),
        bind("b2", "mouse_4", "t2", { triggerMode: "longPress" }),
        bind("b3", "thumb_01", "t1", { layer: "hypershift" }),
        bind("b4", "thumb_01", "k", { triggerMode: "doublePress" }),
        bind("b5", "mouse_4", "k"),
      ],
    });
    const issues = checkProfile(config, "p1");
    expect(issues).toMatchObject([
      { kind: "duplicate", bindings: [{ id: "b1" }, { id: "b2" }] },
      // The same shortcut on a double press and a plain press: a choice, noted.
      { kind: "duplicate", bindings: [{ id: "b4" }, { id: "b5" }] },
    ]);
  });
});
