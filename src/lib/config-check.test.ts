import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { checkProfile, duplicatesOnDevice, duplicatesSignature, sameAsByControl } from "./config-check";
import { controlWithGesture } from "./labels";
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

  it("keeps the duplicates of the mouse shown, marks each button with the others, signs the set", () => {
    const base = makeConfig();
    const other = (id: string) => ({ ...base.physicalControls[0]!, id, deviceId: "v3" });
    const config = makeConfig({
      physicalControls: [...base.physicalControls, other("v3_mouse_4"), other("v3_thumb_01")],
      actions: [key("k", "A", { ctrl: true }), key("k2", "A", { ctrl: true })],
      settings: { ...base.settings, acceptedConflicts: [] },
      bindings: [
        bind("b1", "thumb_01", "k"),
        bind("b2", "mouse_4", "k2", { triggerMode: "longPress" }),
        bind("b3", "v3_thumb_01", "k"),
        bind("b4", "v3_mouse_4", "k2", { triggerMode: "longPress" }),
      ],
    });
    const issues = checkProfile(config, "p1");
    // The same group on both mice: one each, not twice on one.
    expect(issues).toHaveLength(2);
    const shown = duplicatesOnDevice(issues, config, base.physicalControls[0]!.deviceId);
    expect(shown).toMatchObject([{ bindings: [{ id: "b1" }, { id: "b2" }] }]);
    expect(duplicatesOnDevice(issues, config, "v3")).toMatchObject([{ bindings: [{ id: "b3" }, { id: "b4" }] }]);
    expect(duplicatesOnDevice(issues, config, null)).toEqual([]);

    const sameAs = sameAsByControl(shown, "standard");
    expect(sameAs.get("thumb_01")).toEqual([controlWithGesture("mouse_4", "longPress")]);
    expect(sameAs.get("mouse_4")).toEqual([controlWithGesture("thumb_01")]);
    expect(sameAsByControl(shown, "hypershift").size).toBe(0);

    expect(duplicatesSignature(shown)).toBe(duplicatesSignature([...shown].reverse()));
    expect(duplicatesSignature(shown)).not.toBe(duplicatesSignature(duplicatesOnDevice(issues, config, "v3")));
  });
});
