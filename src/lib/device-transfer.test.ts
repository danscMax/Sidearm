import { describe, expect, it } from "vitest";
import type { AppConfig, Binding, PhysicalControl } from "./config";
import { RAZER_NAGA_DEVICE_ID } from "./config";
import { NAGA_V3_DEVICE_ID } from "./devices";
import { applyDeviceTransfer, planDeviceTransfer, retargetImportedBindings } from "./device-transfer";
import { makeAction, makeConfig } from "./test-fixtures";

const control = (id: string, deviceId: string): PhysicalControl => ({
  id, deviceId, family: "thumbGrid", defaultName: id, remappable: true, capabilityStatus: "verified",
});

const binding = (id: string, controlId: string, extra: Partial<Binding> = {}): Binding => ({
  id, profileId: "p1", layer: "standard", controlId, label: id, actionId: "a1", enabled: true, ...extra,
});

function twoMice(bindings: Binding[]): AppConfig {
  const config = makeConfig({ bindings, actions: [makeAction({ type: "shortcut", payload: { key: "A", ctrl: true, shift: false, alt: false, win: false } })] });
  config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "Razer Naga V3 Pro", builtin: true });
  config.physicalControls.push(control("v3_thumb_01", NAGA_V3_DEVICE_ID), control("v3_wheel_left", NAGA_V3_DEVICE_ID));
  return config;
}

describe("copying assignments between mice", () => {
  it("copies to the same place, translates the side button to the tilt, and clones actions", () => {
    const config = twoMice([binding("b1", "thumb_01"), binding("b2", "mouse_4"), binding("b3", "thumb_01", { profileId: "p2" })]);
    const plan = planDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, ["p1"], "keep");
    expect(plan.map((item) => [item.binding.id, item.target, item.outcome])).toEqual([
      ["b1", "v3_thumb_01", "copy"],
      ["b2", "v3_wheel_left", "copy"],
    ]);
    const next = applyDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, plan);
    const copies = next.bindings.filter((item) => item.controlId.startsWith("v3_"));
    expect(copies).toHaveLength(2);
    expect(copies.every((item) => item.actionId !== "a1")).toBe(true);
    expect(new Set(copies.map((item) => item.actionId)).size).toBe(1);
    expect(next.actions.filter((action) => action.id === copies[0].actionId)).toHaveLength(1);
    expect(next.bindings.filter((item) => item.actionId === "a1")).toHaveLength(3);
  });

  it("keeps or replaces an occupied control and skips controls with no counterpart", () => {
    const config = twoMice([
      binding("b1", "thumb_01"),
      binding("own", "v3_thumb_01", { actionId: "a1" }),
      binding("chord", "thumb_01", { triggerMode: "chord", chordPartner: "missing" }),
    ]);
    const keep = planDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, ["p1"], "keep");
    expect(keep.map((item) => item.outcome)).toEqual(["occupied", "noMatch"]);
    expect(applyDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, keep).bindings).toEqual(config.bindings);
    const replace = planDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, ["p1"], "replace");
    const next = applyDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, replace);
    expect(next.bindings.some((item) => item.id === "own")).toBe(false);
    expect(next.bindings.filter((item) => item.controlId === "v3_thumb_01")).toHaveLength(1);
  });

  it("puts an imported profile from another mouse on the chosen one", () => {
    const config = makeConfig({ bindings: [binding("i1", "v3_thumb_01"), binding("i2", "v3_top_special_01"), binding("own", "thumb_01")] });
    const { config: next, dropped } = retargetImportedBindings(config, new Set(["i1", "i2"]), RAZER_NAGA_DEVICE_ID);
    expect(dropped).toBe(1);
    expect(next.bindings.map((item) => [item.id, item.controlId])).toEqual([["i1", "thumb_01"], ["own", "thumb_01"]]);
  });

  it("never lands on a reserved placeholder of the other mouse", () => {
    const config = twoMice([binding("t", "v3_wheel_left")]);
    // The V2 seed has a non-remappable `wheel_left` placeholder beside its real side button.
    config.physicalControls.push({ ...control("wheel_left", RAZER_NAGA_DEVICE_ID), remappable: false });
    const plan = planDeviceTransfer(config, NAGA_V3_DEVICE_ID, RAZER_NAGA_DEVICE_ID, ["p1"], "keep");
    expect(plan.map((item) => item.target)).toEqual(["mouse_4"]);
  });
});
