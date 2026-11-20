import { describe, expect, it } from "vitest";

import type { Action, Binding } from "./config";
import { isBuiltinControl, playsWithoutSidearm } from "./onboard-mapping";
import { makeConfig } from "./test-fixtures";

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

  it.each(["NumLock", "VK_144", "VK_232", "!", "unknown", "F25"])("requires a firmware-supported primary key: %s", (key) => {
    expect(playsWithoutSidearm(binding(), { ...shortcut, type: "shortcut", payload: { key, ctrl: true, shift: false, alt: false, win: false } })).toBe(false);
  });

  it.each(["C", "С", "Return", "F24", "VK_96", "Minus", ""])("keeps firmware keys and modifier-only shortcuts: %s", (key) => {
    expect(playsWithoutSidearm(binding(), { ...shortcut, type: "shortcut", payload: { key, ctrl: true, shift: false, alt: false, win: false } })).toBe(true);
  });

  it("is a plain press of a shortcut or a plain click or scroll", () => {
    expect(playsWithoutSidearm(binding(), shortcut)).toBe(true);
    expect(playsWithoutSidearm(binding(), click("scrollDown"))).toBe(true);
    expect(playsWithoutSidearm(binding(), click("leftClick", true))).toBe(false);
    expect(playsWithoutSidearm(binding(), text)).toBe(false);
    expect(playsWithoutSidearm(binding({ triggerMode: "longPress" }), shortcut)).toBe(false);
    expect(playsWithoutSidearm(binding({ triggerMode: "chord" }), shortcut)).toBe(false);
  });

});
