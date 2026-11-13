import { describe, expect, it } from "vitest";
import type { Action, AppConfig, Binding } from "./config";
import { compareMice, copyAssignments, placeSlot, reorderProfiles, slotBindings, type Slot } from "./binding-moves";
import { makeAction, makeConfig } from "./test-fixtures";

const key = (id: string, keyName: string): Action =>
  makeAction({ id, type: "shortcut", displayName: keyName, payload: { key: keyName, ctrl: false, shift: false, alt: false, win: false } });

const bind = (id: string, controlId: string, actionId: string, extra: Partial<Binding> = {}): Binding => ({
  id, profileId: "p1", layer: "standard", controlId, label: actionId, actionId, enabled: true, ...extra,
});

function setup(): AppConfig {
  return makeConfig({
    actions: [key("a", "A"), key("b", "B"), key("c", "C")],
    bindings: [
      bind("b1", "thumb_01", "a"),
      bind("b1-long", "thumb_01", "c", { triggerMode: "longPress" }),
      bind("b2", "mouse_4", "b"),
    ],
  });
}

const slot = (controlId: string, extra: Partial<Slot> = {}): Slot => ({ profileId: "p1", layer: "standard", controlId, ...extra });
const actionsAt = (config: AppConfig, at: Slot) => slotBindings(config, at).map((b) => b.actionId).sort();

describe("placeSlot", () => {
  it("swaps two occupied buttons with every press pattern, ids stay unique", () => {
    const { config, outcome } = placeSlot(setup(), slot("thumb_01"), slot("mouse_4"), "move");
    expect(outcome).toBe("swapped");
    expect(actionsAt(config, slot("mouse_4"))).toEqual(["a", "c"]);
    expect(actionsAt(config, slot("thumb_01"))).toEqual(["b"]);
    expect(new Set(config.bindings.map((b) => b.id)).size).toBe(config.bindings.length);
    expect(config.actions).toHaveLength(3);
  });

  it("moves onto an empty button and onto another layer", () => {
    const { config, outcome } = placeSlot(setup(), slot("mouse_4"), slot("mouse_4", { layer: "hypershift2" }), "move");
    expect(outcome).toBe("moved");
    expect(actionsAt(config, slot("mouse_4"))).toEqual([]);
    expect(actionsAt(config, slot("mouse_4", { layer: "hypershift2" }))).toEqual(["b"]);
  });

  it("copies into another profile, replacing the whole target button with fresh actions", () => {
    const base = setup();
    base.bindings.push(bind("p2-long", "thumb_01", "b", { profileId: "p2", triggerMode: "doublePress" }));
    const { config, outcome } = placeSlot(base, slot("thumb_01"), slot("thumb_01", { profileId: "p2" }), "copy");
    expect(outcome).toBe("copied");
    const copied = slotBindings(config, slot("thumb_01", { profileId: "p2" }));
    expect(copied.map((b) => b.triggerMode ?? "press").sort()).toEqual(["longPress", "press"]);
    expect(copied.every((b) => !["a", "c"].includes(b.actionId))).toBe(true);
    expect(actionsAt(config, slot("thumb_01"))).toEqual(["a", "c"]);
  });

  it("does nothing for an empty source or the same slot", () => {
    expect(placeSlot(setup(), slot("thumb_02"), slot("mouse_4"), "move").outcome).toBe("none");
    expect(placeSlot(setup(), slot("mouse_4"), slot("mouse_4"), "move").outcome).toBe("none");
  });
});

describe("reorderProfiles", () => {
  it("moves a profile to the target's place by renumbering priorities", () => {
    const base = makeConfig({ profiles: [
      { id: "a", name: "A", enabled: true, priority: 3 },
      { id: "b", name: "B", enabled: true, priority: 2 },
      { id: "c", name: "C", enabled: true, priority: 1 },
    ] });
    const order = (config: AppConfig) => [...config.profiles].sort((x, y) => y.priority - x.priority).map((p) => p.id);
    expect(order(reorderProfiles(base, "c", "a"))).toEqual(["c", "a", "b"]);
    expect(order(reorderProfiles(base, "a", "c"))).toEqual(["b", "c", "a"]);
    expect(reorderProfiles(base, "a", "a")).toBe(base);
  });
});

describe("copyAssignments", () => {
  it("copies a layer into another layer, keeping occupied buttons unless replacing", () => {
    const base = setup();
    base.bindings.push(bind("hs", "mouse_4", "c", { layer: "hypershift2" }));
    const kept = copyAssignments(base, { profileId: "p1", layer: "standard" }, { profileId: "p1", layer: "hypershift2" }, false);
    expect([kept.copied, kept.kept]).toEqual([1, 1]);
    expect(actionsAt(kept.config, slot("mouse_4", { layer: "hypershift2" }))).toEqual(["c"]);
    const replaced = copyAssignments(base, { profileId: "p1", layer: "standard" }, { profileId: "p1", layer: "hypershift2" }, true);
    expect(replaced.copied).toBe(2);
  });

  it("skips menus", () => {
    const base = setup();
    base.actions.push(makeAction({ id: "m", type: "menu", displayName: "M", payload: { items: [] } } as never));
    base.bindings.push(bind("menu", "thumb_02", "m"));
    const result = copyAssignments(base, { profileId: "p1", layer: "all" }, { profileId: "p2", layer: "same" }, true);
    expect([result.copied, result.menus]).toEqual([2, 1]);
  });
});

describe("compareMice", () => {
  it("puts both mice's buttons of one place in a row and marks the rows that differ", () => {
    const config = setup();
    config.devices.push({ id: "razer-naga-v3", name: "V3", builtin: true });
    config.physicalControls.push(
      { id: "v3_thumb_01", deviceId: "razer-naga-v3", family: "thumbGrid", defaultName: "1", remappable: true, capabilityStatus: "verified" },
      { id: "v3_wheel_left", deviceId: "razer-naga-v3", family: "topPanel", defaultName: "<", remappable: true, capabilityStatus: "verified" },
    );
    config.bindings.push(bind("v1", "v3_thumb_01", "a"), bind("v1-long", "v3_thumb_01", "c", { triggerMode: "longPress" }), bind("v2", "v3_wheel_left", "a"));
    const rows = compareMice(config, "standard", "p1", ["razer-naga", "razer-naga-v3"]);
    expect(rows).toEqual([
      { place: "thumb_01", cells: ["a", "c ⌛"].map(() => "a · c ⌛"), differs: false },
      { place: "wheel_left", cells: ["b", "a"], differs: true },
    ]);
  });
});
