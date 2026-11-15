import { describe, expect, it } from "vitest";

import type { Action, Binding, EncoderMapping } from "./config";
import { isBuiltinControl, offlineAssignment, offlineProfileId, offlineWriteTarget, onboardBindings, playsWithoutSidearm } from "./onboard-mapping";
import { NAGA_V3_DEVICE_ID } from "./devices";
import { makeAction, makeConfig } from "./test-fixtures";

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

  it("knows the profile written at exit", () => {
    const config = makeConfig();
    expect(offlineProfileId(config)).toBe(config.settings.fallbackProfileId);
    config.settings.offlineProfileId = "@active";
    expect(offlineProfileId(config)).toBeNull();
  });
});

describe.each(["offline", "offlineHypershift"] as const)("offlineAssignment: %s", (layer) => {
  const shortcut = makeAction({ type: "shortcut", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } });
  const text = makeAction({ id: "text", type: "textSnippet", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } });
  const binding = (extra: Partial<Binding> = {}): Binding => ({
    id: "b", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: shortcut.id, enabled: true, label: "Copy", ...extra,
  });
  const resolve = (bindings: Binding[], actions: Action[] = [shortcut, text]) =>
    offlineAssignment(makeConfig({ bindings, actions }), "p1", "thumb_01", layer);

  it("inherits the standard press when there is no own assignment", () => {
    expect(resolve([binding()])).toMatchObject({ kind: "inherited", action: shortcut });
    expect(resolve([])).toEqual({ kind: "silent" });
    expect(resolve([binding({ enabled: false })])).toEqual({ kind: "silent" });
  });

  it("uses an enabled own press ahead of the live binding", () => {
    const own = binding({ id: "own", layer });
    expect(resolve([binding({ actionId: text.id }), own])).toEqual({ kind: "own", action: shortcut, binding: own });
  });

  it.each(["hold", "chord", "longPress", "doublePress", "triplePress"] as const)("ignores an invalid own %s", (triggerMode) => {
    expect(resolve([binding({ layer, triggerMode, actionId: text.id }), binding()])).toMatchObject({ kind: "inherited", action: shortcut });
  });

  it("ignores a disabled own binding and bindings of other profiles or controls", () => {
    expect(resolve([
      binding({ layer, enabled: false }), binding({ layer, profileId: "p2" }), binding({ layer, controlId: "mouse_4" }), binding(),
    ])).toMatchObject({ kind: "inherited", action: shortcut });
  });

  it("keeps a deliberately silent or unplayable own assignment silent", () => {
    const own = binding({ layer, actionId: "off" });
    const disabled = makeAction({ id: "off", type: "disabled", payload: {} });
    expect(resolve([binding(), own], [shortcut, disabled])).toEqual({ kind: "silent", binding: own });
    const unsupported = makeAction({ id: "off", type: "shortcut", payload: { key: "NumLock", ctrl: false, shift: false, alt: false, win: false } });
    expect(resolve([binding(), own], [shortcut, unsupported])).toEqual({ kind: "silent", binding: own });
    expect(resolve([binding(), own], [shortcut])).toEqual({ kind: "silent", binding: own });
  });

  it("reports the live action that cannot be stored", () => {
    expect(resolve([binding({ actionId: text.id })])).toMatchObject({ kind: "silent", liveAction: text });
    expect(resolve([binding({ triggerMode: "longPress" })])).toEqual({ kind: "silent" });
  });

  it("uses firmware-playable mouse actions too", () => {
    const click = makeAction({ type: "mouseAction", payload: { action: "leftClick" } });
    expect(resolve([binding({ layer })], [click])).toMatchObject({ kind: "own", action: click });
  });
});

it("derives firmware HyperShift before standard, without falling through an unplayable action", () => {
  const standard = makeAction({ id: "a", type: "shortcut", payload: { key: "A", ctrl: false, shift: false, alt: false, win: false } });
  const hs = makeAction({ id: "hs", type: "textSnippet", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } });
  const binding: Binding = { id: "b", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: "a", enabled: true, label: "A" };
  const config = makeConfig({ actions: [standard, hs], bindings: [binding, { ...binding, id: "hs", layer: "hypershift", actionId: "hs" }] });
  expect(offlineAssignment(config, "p1", "thumb_01", "offline")).toMatchObject({ kind: "inherited", action: standard });
  expect(offlineAssignment(config, "p1", "thumb_01", "offlineHypershift")).toMatchObject({ kind: "silent", liveAction: hs });
  config.actions[1] = { ...standard, id: "hs" };
  expect(offlineAssignment(config, "p1", "thumb_01", "offlineHypershift")).toMatchObject({ kind: "inherited", action: config.actions[1] });
  config.bindings[1].enabled = false;
  expect(offlineAssignment(config, "p1", "thumb_01", "offlineHypershift")).toMatchObject({ kind: "inherited", action: standard });
  config.bindings.push({ ...binding, id: "own-standard", layer: "offline", actionId: "hs" });
  expect(offlineAssignment(config, "p1", "thumb_01", "offlineHypershift")).toMatchObject({ kind: "inherited", action: standard });
});

describe("offlineWriteTarget", () => {
  it("writes the configured or fallback profile and reports window-following separately", () => {
    const config = makeConfig();
    expect(offlineWriteTarget(config, "p1", "razer-naga")).toEqual({ written: true, followsWindow: false });
    expect(offlineWriteTarget(config, "p2", "razer-naga")).toEqual({ written: false, followsWindow: false });
    config.settings.offlineProfileId = "p2";
    expect(offlineWriteTarget(config, "p2", "razer-naga").written).toBe(true);
    config.settings.offlineProfileId = "@active";
    expect(offlineWriteTarget(config, "p1", "razer-naga")).toEqual({ written: false, followsWindow: true });
  });

  it("also writes profiles linked to V3 banks, including while following the window", () => {
    const config = makeConfig();
    config.profiles[1].deviceSlots = { [NAGA_V3_DEVICE_ID]: 3, "razer-naga": 2 };
    expect(offlineWriteTarget(config, "p2", NAGA_V3_DEVICE_ID)).toEqual({ written: true, bank: 3, followsWindow: false });
    expect(offlineWriteTarget(config, "p2", "razer-naga")).toEqual({ written: false, followsWindow: false });
    config.settings.offlineProfileId = "@active";
    expect(offlineWriteTarget(config, "p2", NAGA_V3_DEVICE_ID)).toEqual({ written: true, bank: 3, followsWindow: true });
  });
});
