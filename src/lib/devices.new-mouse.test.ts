import { describe, expect, it } from "vitest";
import type { Device, PhysicalControl } from "./config";
import { newMouseNotice } from "./devices";
import { makeConfig } from "./test-fixtures";

const V3 = "razer-naga-v3";

function config() {
  const base = makeConfig();
  return makeConfig({
    devices: [...base.devices, { id: V3, name: "Razer Naga V3 Pro", builtin: true, hotspots: [] } as Device],
    physicalControls: [
      ...base.physicalControls,
      { id: "v3_thumb_01", deviceId: V3, family: "thumbGrid", defaultName: "Thumb 1", remappable: true, capabilityStatus: "verified" },
    ] as PhysicalControl[],
    actions: [{ id: "a1", type: "shortcut", displayName: "Copy", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } }],
    bindings: [{ id: "b1", profileId: "p1", layer: "standard", controlId: "thumb_01", label: "Copy", actionId: "a1", enabled: true }],
  });
}

describe("new mouse notice", () => {
  it("greets a connected mouse with nothing assigned and offers the other one's assignments", () => {
    const notice = newMouseNotice(config(), ["razer-naga", V3], []);
    expect(notice?.device.id).toBe(V3);
    expect(notice?.copyFrom?.id).toBe("razer-naga");
  });

  it("stays quiet once dismissed, unplugged or assigned", () => {
    expect(newMouseNotice(config(), ["razer-naga", V3], [V3])).toBeNull();
    expect(newMouseNotice(config(), ["razer-naga"], [])).toBeNull();
    const assigned = config();
    assigned.bindings.push({ id: "b2", profileId: "p2", layer: "hypershift", controlId: "v3_thumb_01", label: "Copy", actionId: "a1", enabled: true });
    expect(newMouseNotice(assigned, ["razer-naga", V3], [])).toBeNull();
  });
});
