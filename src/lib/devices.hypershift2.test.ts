import { describe, expect, it } from "vitest";
import type { PhysicalControl } from "./config";
import { canBeHypershift2Trigger, deviceLayers, hypershift2ControlId, setHypershift2Trigger } from "./devices";
import { makeConfig } from "./test-fixtures";

const V3 = "razer-naga-v3";

function config() {
  const base = makeConfig();
  return makeConfig({
    physicalControls: [
      ...base.physicalControls,
      { id: "v3_mouse_right", deviceId: V3, family: "topPanel", defaultName: "Right", remappable: false, capabilityStatus: "verified" },
      { id: "v3_thumb_01", deviceId: V3, family: "thumbGrid", defaultName: "Thumb 1", remappable: true, capabilityStatus: "verified" },
    ] as PhysicalControl[],
  });
}

describe("HyperShift 2 trigger per profile", () => {
  it("is offered only on the layout's native buttons", () => {
    expect(canBeHypershift2Trigger(config(), "v3_mouse_right")).toBe(true);
    expect(canBeHypershift2Trigger(config(), "v3_thumb_01")).toBe(false);
    expect(canBeHypershift2Trigger(config(), "mouse_4")).toBe(false);
  });

  it("is set in one profile only and removed again", () => {
    const set = setHypershift2Trigger(config(), "p2", "v3_mouse_right", true);
    expect(hypershift2ControlId(set, "p2", V3)).toBe("v3_mouse_right");
    expect(hypershift2ControlId(set, "p1", V3)).toBeNull();
    const cleared = setHypershift2Trigger(set, "p2", "v3_mouse_right", false);
    expect(cleared.profiles.find((profile) => profile.id === "p2")).not.toHaveProperty("hypershift2Triggers");
  });

  it("shows the HyperShift 2 layers only where the profile has a trigger", () => {
    const set = setHypershift2Trigger(config(), "p2", "v3_mouse_right", true);
    expect(deviceLayers(set, "p2", V3, "standard")).toEqual(["standard", "hypershift", "hypershift2", "hypershiftBoth"]);
    expect(deviceLayers(set, "p1", V3, "standard")).toEqual(["standard", "hypershift"]);
    // A selected HyperShift 2 layer stays reachable after the trigger is gone.
    expect(deviceLayers(set, "p1", V3, "hypershift2")).toHaveLength(4);
  });
});
