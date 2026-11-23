import { describe, expect, it } from "vitest";

import type { Action, Binding } from "./config";
import {
  classifyHardwarePlayability,
  evaluateHybridBankStatus,
  isBuiltinControl,
  playsWithoutSidearm,
  summarizeProfileHardwarePlayability,
} from "./onboard-mapping";
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

describe("classifyHardwarePlayability", () => {
  const shortcut = { id: "a_key", type: "shortcut", displayName: "Copy", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } } as Action;
  const badKey = { id: "a_bad", type: "shortcut", displayName: "NumLock", payload: { key: "NumLock", ctrl: false, shift: false, alt: false, win: false } } as Action;
  const text = { id: "a_txt", type: "textSnippet", displayName: "Hi", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } } as Action;
  const modClick = { id: "a_mod", type: "mouseAction", displayName: "Ctrl+Click", payload: { action: "leftClick", ctrl: true } } as Action;
  const bind = (extra: Partial<Binding> = {}): Binding => ({
    id: "b1", profileId: "p1", layer: "standard", controlId: "thumb_01", label: "B", actionId: shortcut.id, enabled: true, ...extra,
  });

  it("marks plain compatible shortcuts on standard/hypershift as in mouse", () => {
    const b = bind();
    const config = makeConfig({ actions: [shortcut], bindings: [b] });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, shortcut)).toEqual({ location: "mouse" });
    expect(classifyHardwarePlayability(config, "p1", "hypershift", "thumb_01", b, shortcut)).toEqual({ location: "mouse" });
  });

  it("reports every Sidearm-only blocking reason accurately", () => {
    const b = bind();
    const config = makeConfig({ actions: [shortcut, badKey, text, modClick], bindings: [b] });
    expect(classifyHardwarePlayability(config, "p1", "hypershift2", "thumb_01", b, shortcut)).toEqual({ location: "sidearm", reason: "layer" });
    expect(classifyHardwarePlayability(config, "p1", "hypershiftBoth", "thumb_01", b, shortcut)).toEqual({ location: "sidearm", reason: "layer" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", bind({ triggerMode: "chord" }), shortcut)).toEqual({ location: "sidearm", reason: "chord" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", bind({ triggerMode: "doublePress" }), shortcut)).toEqual({ location: "sidearm", reason: "gesture" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, { ...shortcut, conditions: [{ type: "windowTitleContains", value: "Docs" }] })).toEqual({ location: "sidearm", reason: "conditions" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, { ...shortcut, conditions: [{ type: "windowTitleContains", value: "   " }] })).toEqual({ location: "sidearm", reason: "conditions" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", bind({ throttleMs: 250 }), shortcut)).toEqual({ location: "sidearm", reason: "throttle" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, badKey)).toEqual({ location: "sidearm", reason: "key" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, modClick)).toEqual({ location: "sidearm", reason: "mouseModifiers" });
    expect(classifyHardwarePlayability(config, "p1", "standard", "thumb_01", b, text)).toEqual({ location: "sidearm", reason: "actionType", actionType: "textSnippet" });
  });

  it("downgrades a plain key when the same control also has an extra gesture (including Standard inherited under HyperShift) or HS2 override", () => {
    const plain = bind({ id: "b_plain" });
    const hsPlain = bind({ id: "b_hs_plain", layer: "hypershift" });
    const dbl = bind({ id: "b_dbl", triggerMode: "doublePress" });
    const withGesture = makeConfig({ actions: [shortcut, text], bindings: [plain, hsPlain, dbl] });
    expect(classifyHardwarePlayability(withGesture, "p1", "standard", "thumb_01", plain, shortcut)).toEqual({ location: "sidearm", reason: "gesture" });
    expect(classifyHardwarePlayability(withGesture, "p1", "hypershift", "thumb_01", hsPlain, shortcut)).toEqual({ location: "sidearm", reason: "gesture" });
    // Unstorable primary action keeps its actionType reason even when an extra gesture exists.
    expect(classifyHardwarePlayability(withGesture, "p1", "standard", "thumb_01", plain, text)).toEqual({ location: "sidearm", reason: "actionType", actionType: "textSnippet" });

    const hs2 = bind({ id: "b_hs2", layer: "hypershift2" });
    const withHs2 = makeConfig({ actions: [shortcut], bindings: [plain, hs2] });
    expect(classifyHardwarePlayability(withHs2, "p1", "standard", "thumb_01", plain, shortcut)).toEqual({ location: "mouse" });
    expect(classifyHardwarePlayability(withHs2, "p1", "standard", "thumb_01", plain, shortcut, { checkHs2: true })).toEqual({ location: "sidearm", reason: "hs2Override" });
  });

  it("summarizes in-mouse vs Sidearm-only assignments (including gesture-only buttons) for a profile and device", () => {
    const b1 = bind({ id: "b1", layer: "standard", controlId: "thumb_01", actionId: shortcut.id });
    const b2 = bind({ id: "b2", layer: "hypershift", controlId: "thumb_01", actionId: text.id });
    const b3 = bind({ id: "b3", controlId: "thumb_01", layer: "hypershift2", actionId: shortcut.id });
    const config = makeConfig({ actions: [shortcut, text], bindings: [b1, b2, b3] });
    expect(summarizeProfileHardwarePlayability(config, "p1", "razer-naga")).toEqual({ inMouse: 1, sidearmOnly: 1 });
    expect(summarizeProfileHardwarePlayability(config, "p1", "razer-naga", { checkHs2: true })).toEqual({ inMouse: 0, sidearmOnly: 2 });

    const gestureOnly = makeConfig({
      actions: [shortcut],
      bindings: [bind({ id: "b_lp", layer: "standard", controlId: "thumb_01", triggerMode: "longPress", actionId: shortcut.id })],
    });
    expect(summarizeProfileHardwarePlayability(gestureOnly, "p1", "razer-naga")).toEqual({ inMouse: 0, sidearmOnly: 1 });
  });

  it("evaluates hybrid bank status and surfaces blockers honestly", () => {
    const config = makeConfig({
      actions: [shortcut, text],
      bindings: [
        bind({ id: "b1", layer: "standard", controlId: "thumb_01", actionId: shortcut.id }),
        bind({ id: "b2", layer: "hypershift", controlId: "thumb_01", actionId: text.id }),
      ],
    });
    expect(evaluateHybridBankStatus(config, "p1", "razer-naga", { isDedicatedOffline: true, userBankCount: 2, consumerSignals: true }))
      .toEqual({ willActivate: false, nativeCount: 1, sidearmCount: 1, blocker: "dedicatedOffline" });
    expect(evaluateHybridBankStatus(config, "p1", "razer-naga", { isDedicatedOffline: false, userBankCount: 1, consumerSignals: true }))
      .toEqual({ willActivate: false, nativeCount: 1, sidearmCount: 1, blocker: "singleUserBank" });
    expect(evaluateHybridBankStatus(config, "p1", "razer-naga", { isDedicatedOffline: false, userBankCount: 2, consumerSignals: false }))
      .toEqual({ willActivate: false, nativeCount: 1, sidearmCount: 1, blocker: "keySignalsMode" });
    expect(evaluateHybridBankStatus(config, "p1", "razer-naga", { isDedicatedOffline: false, userBankCount: 2, consumerSignals: true }))
      .toEqual({ willActivate: true, nativeCount: 1, sidearmCount: 1 });

    // Profile-level HyperShift 2 trigger suppresses hybrid mode (mirrors Rust hybrid_native_action).
    const hs2Config = {
      ...config,
      profiles: config.profiles.map((p) => p.id === "p1" ? { ...p, hypershift2Triggers: ["mouse_4" as const] } : p),
    };
    expect(evaluateHybridBankStatus(hs2Config, "p1", "razer-naga", { isDedicatedOffline: false, userBankCount: 2, consumerSignals: true }))
      .toEqual({ willActivate: false, nativeCount: 0, sidearmCount: 2, blocker: "hs2Trigger" });
    expect(evaluateHybridBankStatus(makeConfig(), "p1", "razer-naga", { isDedicatedOffline: false, userBankCount: 2, consumerSignals: true }))
      .toEqual({ willActivate: false, nativeCount: 0, sidearmCount: 0, blocker: "noNativeKeys" });
  });
});
