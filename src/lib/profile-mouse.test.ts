import { describe, expect, it } from "vitest";
import { importProfile, setProfileDeviceSlot, setProfileMouse } from "./config-editing";
import type { Profile } from "./config";
import { makeConfig } from "./test-fixtures";

describe("per-mouse profile settings", () => {
  it("keeps each mouse's settings apart and drops an emptied mouse", () => {
    let config = setProfileMouse(makeConfig(), "p1", "razer-naga", { mouseDpi: 1600 });
    config = setProfileMouse(config, "p1", "razer-naga-v3", { mouseDpi: 32000, mouseDpiStages: [16000, 32000] });
    expect(config.profiles[0].deviceMouse).toEqual({
      "razer-naga": { mouseDpi: 1600 },
      "razer-naga-v3": { mouseDpi: 32000, mouseDpiStages: [16000, 32000] },
    });
    config = setProfileMouse(config, "p1", "razer-naga", { mouseDpi: undefined });
    expect(Object.keys(config.profiles[0].deviceMouse ?? {})).toEqual(["razer-naga-v3"]);
    config = setProfileMouse(config, "p1", "razer-naga-v3", { mouseDpi: undefined, mouseDpiStages: undefined });
    expect(config.profiles[0].deviceMouse).toBeUndefined();
    expect(config.profiles[1].deviceMouse).toBeUndefined();
  });

  it("imports a pre-v5 profile's DPI onto this config's mice only", () => {
    const config = makeConfig();
    config.devices.push({ id: "razer-naga-v3", name: "V3", builtin: true });
    const old = { id: "x", name: "Old", enabled: true, priority: 0, mouseDpi: 1600 } as Profile;
    const imported = importProfile(config, { version: 2, exportedAt: "", profile: old, bindings: [], actions: [], appMappings: [] });
    const profile = imported.profiles[imported.profiles.length - 1] as Profile & { mouseDpi?: number };
    expect(profile.mouseDpi).toBeUndefined();
    expect(profile.deviceMouse).toEqual({ "razer-naga": { mouseDpi: 1600 }, "razer-naga-v3": { mouseDpi: 1600 } });
    const foreign = { ...old, mouseDpi: undefined, deviceMouse: { "other-pc-mouse": { mouseDpi: 800 } } } as Profile;
    const again = importProfile(config, { version: 2, exportedAt: "", profile: foreign, bindings: [], actions: [], appMappings: [] });
    expect(again.profiles[again.profiles.length - 1].deviceMouse).toBeUndefined();
  });

  it("gives a bank to one profile only", () => {
    let config = setProfileDeviceSlot(makeConfig(), "p1", "razer-naga-v3", 2);
    config = setProfileDeviceSlot(config, "p2", "razer-naga-v3", 2);
    expect(config.profiles[0].deviceSlots).toBeUndefined();
    expect(config.profiles[1].deviceSlots).toEqual({ "razer-naga-v3": 2 });
  });
});
