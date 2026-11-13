import { describe, expect, it } from "vitest";

import type { Action, Binding, EncoderMapping } from "./config";
import { isBuiltinControl, offlineProfileId, onboardBindings, playsWithoutSidearm } from "./onboard-mapping";
import { makeConfig } from "./test-fixtures";

function mapping(
  controlId: string,
  layer: "standard" | "hypershift",
  encodedKey: string,
): EncoderMapping {
  return {
    controlId,
    layer,
    encodedKey,
    source: "detected",
    verified: false,
  };
}

describe("onboardBindings", () => {
  it("keeps only standard-layer thumb and top-button controls", () => {
    const config = makeConfig({
      encoderMappings: [
        mapping("thumb_01", "standard", "F13"),
        mapping("thumb_12", "standard", "F24"),
        mapping("top_aux_01", "standard", "Alt+F23"),
        mapping("top_aux_01", "hypershift", "Ctrl+Alt+F23"),
        mapping("thumb_01", "hypershift", "Ctrl+Alt+Shift+F13"),
        mapping("mouse_4", "standard", "Alt+F13"),
        mapping("wheel_up", "standard", "ScrollUp"),
      ],
    });

    expect(onboardBindings(config)).toEqual([
      { controlId: "thumb_01", encodedKey: "F13" },
      { controlId: "thumb_12", encodedKey: "F24" },
      { controlId: "top_aux_01", encodedKey: "Alt+F23" },
    ]);
  });

  it("ignores a config with no thumb bindings", () => {
    expect(onboardBindings(makeConfig({ encoderMappings: [] }))).toEqual([]);
  });
});

describe("isBuiltinControl", () => {
  it("is true only for controls of the built-in device", () => {
    const config = makeConfig({
      devices: [
        { id: "naga", name: "Naga", builtin: true },
        { id: "pad", name: "Pad" },
      ],
      physicalControls: [
        {
          id: "thumb_01",
          deviceId: "naga",
          family: "thumbGrid",
          defaultName: "Thumb 1",
          remappable: true,
          capabilityStatus: "verified",
        },
        {
          id: "pad-b1",
          deviceId: "pad",
          family: "thumbGrid",
          defaultName: "B1",
          remappable: true,
          capabilityStatus: "verified",
        },
      ],
    });
    expect(isBuiltinControl(config, "thumb_01")).toBe(true);
    expect(isBuiltinControl(config, "pad-b1")).toBe(false);
    expect(isBuiltinControl(config, "missing")).toBe(false);
  });
});

describe("playsWithoutSidearm", () => {
  const binding = (extra: Partial<Binding> = {}): Binding =>
    ({ id: "b", profileId: "p1", layer: "standard", controlId: "thumb_01", label: "b", actionId: "a", enabled: true, ...extra });
  const shortcut = { id: "a", type: "shortcut", displayName: "A", payload: { key: "A", ctrl: true, shift: false, alt: false, win: false } } as Action;
  const text = { id: "a", type: "textSnippet", displayName: "T", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } } as Action;
  const click = (action: string, ctrl = false) => ({ id: "a", type: "mouseAction", displayName: "M", payload: { action, ctrl } }) as Action;

  it("is a plain press of a shortcut or a plain click or scroll", () => {
    expect(playsWithoutSidearm(binding(), shortcut)).toBe(true);
    expect(playsWithoutSidearm(binding(), click("scrollDown"))).toBe(true);
    expect(playsWithoutSidearm(binding(), click("leftClick", true))).toBe(false);
    expect(playsWithoutSidearm(binding(), text)).toBe(false);
    expect(playsWithoutSidearm(binding({ triggerMode: "longPress" }), shortcut)).toBe(false);
    expect(playsWithoutSidearm(binding({ triggerMode: "chord" }), shortcut)).toBe(false);
  });

  it("knows the profile written at exit", () => {
    const config = makeConfig();
    expect(offlineProfileId(config)).toBe(config.settings.fallbackProfileId);
    config.settings.offlineProfileId = "@active";
    expect(offlineProfileId(config)).toBeNull();
  });
});
