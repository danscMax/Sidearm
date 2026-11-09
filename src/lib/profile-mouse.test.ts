import { describe, expect, it } from "vitest";
import { setProfileDeviceSlot, setProfileMouse } from "./config-editing";
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

  it("gives a bank to one profile only", () => {
    let config = setProfileDeviceSlot(makeConfig(), "p1", "razer-naga-v3", 2);
    config = setProfileDeviceSlot(config, "p2", "razer-naga-v3", 2);
    expect(config.profiles[0].deviceSlots).toBeUndefined();
    expect(config.profiles[1].deviceSlots).toEqual({ "razer-naga-v3": 2 });
  });
});
