import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { checkProfile } from "./config-check";
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
});
