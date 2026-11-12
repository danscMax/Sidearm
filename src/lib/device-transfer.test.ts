import { describe, expect, it } from "vitest";
import type { AppConfig, Binding, PhysicalControl } from "./config";
import { RAZER_NAGA_DEVICE_ID } from "./config";
import { NAGA_V3_DEVICE_ID } from "./devices";
import { applyDeviceTransfer, mirrorMouseEdit, planDeviceTransfer, retargetImportedBindings } from "./device-transfer";
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

  it("leaves out HyperShift 2 layers for a mouse without them", () => {
    const config = twoMice([binding("hs2", "v3_thumb_01", { layer: "hypershift2" }), binding("both", "v3_thumb_01", { layer: "hypershiftBoth" })]);
    config.physicalControls.push(control("thumb_01", RAZER_NAGA_DEVICE_ID));
    const plan = planDeviceTransfer(config, NAGA_V3_DEVICE_ID, RAZER_NAGA_DEVICE_ID, ["p1"], "replace");
    expect(plan.map((item) => item.outcome)).toEqual(["noLayer", "noLayer"]);
    const back = planDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, ["p1"], "replace");
    expect(back).toEqual([]);
  });

  it("copies a menu with its own phrases, or shares it when asked", () => {
    const config = twoMice([binding("m", "thumb_01", { actionId: "menu" })]);
    config.actions.push(
      makeAction({ id: "menu", type: "menu", payload: { items: [{ kind: "submenu", id: "s", label: "S", enabled: true, items: [
        { kind: "action", id: "i", label: "Hi", actionId: "phrase", enabled: true },
      ] }] } }),
      makeAction({ id: "phrase", type: "textSnippet", payload: { source: "inline", text: "hi", pasteMode: "clipboardPaste", tags: [] } }),
    );
    const plan = planDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, ["p1"], "keep");
    const own = applyDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, plan);
    const copy = own.bindings.find((item) => item.controlId === "v3_thumb_01")!;
    const menu = own.actions.find((action) => action.id === copy.actionId)!;
    expect(menu.id).not.toBe("menu");
    const inner = menu.type === "menu" && menu.payload.items[0]!.kind === "submenu" ? menu.payload.items[0]!.items[0]! : null;
    expect(inner?.kind === "action" && inner.actionId).not.toBe("phrase");
    expect(own.actions.some((action) => inner?.kind === "action" && action.id === inner.actionId)).toBe(true);

    const shared = applyDeviceTransfer(config, RAZER_NAGA_DEVICE_ID, NAGA_V3_DEVICE_ID, plan, { shareMenus: true });
    expect(shared.bindings.find((item) => item.controlId === "v3_thumb_01")?.actionId).toBe("menu");
    expect(shared.actions).toHaveLength(config.actions.length);
  });

  it("never lands on a reserved placeholder of the other mouse", () => {
    const config = twoMice([binding("t", "v3_wheel_left")]);
    // The V2 seed has a non-remappable `wheel_left` placeholder beside its real side button.
    config.physicalControls.push({ ...control("wheel_left", RAZER_NAGA_DEVICE_ID), remappable: false });
    const plan = planDeviceTransfer(config, NAGA_V3_DEVICE_ID, RAZER_NAGA_DEVICE_ID, ["p1"], "keep");
    expect(plan.map((item) => item.target)).toEqual(["mouse_4"]);
  });
});

describe("keeping the mice alike", () => {
  function synced(bindings: Binding[]): AppConfig {
    const config = twoMice(bindings);
    config.physicalControls.push(control("thumb_01", RAZER_NAGA_DEVICE_ID), control("mouse_4", RAZER_NAGA_DEVICE_ID));
    config.settings.syncMice = true;
    return config;
  }
  const edit = (config: AppConfig, change: (draft: AppConfig) => void) => {
    const next = structuredClone(config);
    change(next);
    return mirrorMouseEdit(config, next);
  };

  it("repeats a new assignment on the same place of the other mouse, sharing its action", () => {
    const config = synced([]);
    const next = edit(config, (draft) => draft.bindings.push(binding("new", "v3_wheel_left")));
    expect(next.bindings.map((item) => [item.controlId, item.actionId])).toEqual([["v3_wheel_left", "a1"], ["mouse_4", "a1"]]);
  });

  it("follows an edit in place of the action, drops the replaced copy and keeps its text once", () => {
    const config = synced([binding("v2", "thumb_01", { actionId: "old" }), binding("v3", "v3_thumb_01")]);
    config.actions.push({ id: "old", type: "textSnippet", displayName: "t", payload: { source: "inline", text: "hi", pasteMode: "clipboardPaste", tags: [] } });
    config.actions[0] = { id: "a1", type: "textSnippet", displayName: "t", payload: { source: "inline", text: "hi", pasteMode: "clipboardPaste", tags: [] } };
    const next = edit(config, (draft) => {
      const action = draft.actions.find((item) => item.id === "a1")!;
      if (action.type === "textSnippet" && action.payload.source === "inline") action.payload.text = "hello";
    });
    expect(next.bindings.find((item) => item.id === "v2")?.actionId).toBe("a1");
    expect(next.actions.map((action) => action.id)).toEqual(["a1"]);
    expect(next.snippetLibrary).toEqual(config.snippetLibrary);
  });

  it("removes on both, skips a layer the other mouse lacks, and does nothing when off", () => {
    const config = synced([binding("v2", "thumb_01"), binding("v3", "v3_thumb_01")]);
    const removed = edit(config, (draft) => { draft.bindings = draft.bindings.filter((item) => item.id !== "v3"); });
    expect(removed.bindings).toEqual([]);
    const hs2 = edit(config, (draft) => draft.bindings.push(binding("hs2", "v3_thumb_01", { layer: "hypershift2" })));
    expect(hs2.bindings.filter((item) => item.layer === "hypershift2").map((item) => item.controlId)).toEqual(["v3_thumb_01"]);
    const off = { ...config, settings: { ...config.settings, syncMice: false } };
    const untouched = structuredClone(off);
    untouched.bindings.pop();
    expect(mirrorMouseEdit(off, untouched)).toBe(untouched);
  });
});
