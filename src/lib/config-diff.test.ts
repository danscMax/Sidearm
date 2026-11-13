import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { describeConfigChange } from "./config-diff";
import { makeConfig } from "./test-fixtures";

const key = (id: string, k: string): Action =>
  ({ id, type: "shortcut", displayName: k, payload: { key: k, ctrl: false, shift: false, alt: false, win: false } }) as Action;
const bind = (id: string, controlId: string, actionId: string, extra: Partial<Binding> = {}): Binding =>
  ({ id, profileId: "p1", layer: "standard", controlId, label: id, actionId, enabled: true, ...extra });

describe("describeConfigChange", () => {
  it("names the places with another assignment and the edited menus, nothing for an unchanged config", () => {
    const menu = { id: "m", type: "menu", displayName: "Phrases", payload: { items: [{ kind: "action", id: "i", label: "A", actionId: "a", enabled: true }] } } as Action;
    const before = makeConfig({ actions: [key("a", "A"), key("b", "B"), menu], bindings: [bind("x", "thumb_01", "a"), bind("y", "mouse_4", "m")] });
    expect(describeConfigChange(before, structuredClone(before))).toEqual({ places: [], menus: [] });

    const after = structuredClone(before);
    after.bindings[0]!.actionId = "b"; // thumb 1 now sends B
    after.bindings.push(bind("z", "thumb_01", "a", { triggerMode: "longPress" })); // a new hold
    const edited = after.actions.find((action) => action.id === "m")!;
    if (edited.type === "menu") edited.payload.items[0]!.label = "A2";
    const change = describeConfigChange(before, after);
    expect(change.places).toHaveLength(2);
    expect(change.menus).toEqual(["Phrases"]);
  });
});
