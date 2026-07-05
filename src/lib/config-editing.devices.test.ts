import { describe, expect, it } from "vitest";
import {
  addLearnedControl,
  createDevice,
  findMappingByEncodedKey,
  removeControl,
  removeDevice,
  renameDevice,
} from "./config-editing";
import { makeConfig } from "./test-fixtures";
import type { Action, AppConfig, Binding } from "./config";

function withLearnedDevice(): { config: AppConfig; deviceId: string; controlId: string } {
  const created = createDevice(makeConfig(), "My Macropad");
  const learned = addLearnedControl(created.config, created.deviceId, "Pad 1", "F19");
  return { config: learned.config, deviceId: created.deviceId, controlId: learned.controlId };
}

describe("createDevice", () => {
  it("creates a slugged unique device and keeps existing ones", () => {
    const { config, deviceId } = createDevice(makeConfig(), "My Macropad");
    expect(deviceId).toBe("my-macropad");
    expect(config.devices.map((d) => d.id)).toEqual(["razer-naga", "my-macropad"]);
    const again = createDevice(config, "My Macropad");
    expect(again.deviceId).toBe("my-macropad-2");
  });

  it("falls back to a generic slug for unusable names", () => {
    const { deviceId } = createDevice(makeConfig(), "!!!");
    expect(deviceId).toBe("device");
  });
});

describe("renameDevice", () => {
  it("renames and ignores blank names", () => {
    const base = createDevice(makeConfig(), "Pad").config;
    expect(renameDevice(base, "pad", "Stream Deck").devices.at(-1)?.name).toBe("Stream Deck");
    expect(renameDevice(base, "pad", "   ").devices.at(-1)?.name).toBe("Pad");
  });
});

describe("addLearnedControl", () => {
  it("creates a tagged control plus a detected standard-layer mapping", () => {
    const { config, deviceId, controlId } = withLearnedDevice();
    const control = config.physicalControls.find((c) => c.id === controlId);
    expect(control).toMatchObject({
      deviceId,
      defaultName: "Pad 1",
      remappable: true,
      capabilityStatus: "verified",
    });
    expect(controlId).toBe("my-macropad-b1");
    const mapping = config.encoderMappings.find((m) => m.controlId === controlId);
    expect(mapping).toMatchObject({
      layer: "standard",
      encodedKey: "F19",
      source: "detected",
      verified: true,
    });
  });

  it("never collides with existing control ids", () => {
    const { config, deviceId } = withLearnedDevice();
    const second = addLearnedControl(config, deviceId, "", "F20");
    expect(second.controlId).toBe("my-macropad-b2");
    const ids = second.config.physicalControls.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Blank name falls back to the id so validation never sees an empty name.
    expect(
      second.config.physicalControls.find((c) => c.id === second.controlId)?.defaultName,
    ).toBe(second.controlId);
  });
});

describe("findMappingByEncodedKey", () => {
  it("matches case-insensitively", () => {
    const { config } = withLearnedDevice();
    expect(findMappingByEncodedKey(config, "f19")?.encodedKey).toBe("F19");
    expect(findMappingByEncodedKey(config, "F21")).toBeUndefined();
  });
});

describe("removeControl / removeDevice cascade", () => {
  function withBinding(): {
    config: AppConfig;
    deviceId: string;
    controlId: string;
  } {
    const { config, deviceId, controlId } = withLearnedDevice();
    const action: Action = {
      id: "act-pad",
      type: "shortcut",
      payload: { key: "K", ctrl: true, shift: false, alt: false, win: false },
      displayName: "Ctrl+K",
    };
    const binding: Binding = {
      id: "bind-pad",
      profileId: "p1",
      layer: "standard",
      controlId,
      label: "Ctrl+K",
      actionId: action.id,
      enabled: true,
    };
    const chordBinding: Binding = {
      id: "bind-chord",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "Chord",
      actionId: action.id,
      triggerMode: "chord",
      chordPartner: controlId,
      enabled: true,
    };
    return {
      config: {
        ...config,
        actions: [...config.actions, action],
        bindings: [...config.bindings, binding, chordBinding],
      },
      deviceId,
      controlId,
    };
  }

  it("removeControl drops the control, its binding/mapping and chord references", () => {
    const { config, controlId } = withBinding();
    const next = removeControl(config, controlId);
    expect(next.physicalControls.some((c) => c.id === controlId)).toBe(false);
    expect(next.encoderMappings.some((m) => m.controlId === controlId)).toBe(false);
    expect(next.bindings.some((b) => b.controlId === controlId)).toBe(false);
    const chord = next.bindings.find((b) => b.id === "bind-chord");
    expect(chord?.chordPartner).toBeUndefined();
    expect(chord?.triggerMode).toBeUndefined();
  });

  it("removeDevice cascades its controls and refuses builtin/last device", () => {
    const { config, deviceId, controlId } = withBinding();
    const next = removeDevice(config, deviceId);
    expect(next.devices.some((d) => d.id === deviceId)).toBe(false);
    expect(next.physicalControls.some((c) => c.deviceId === deviceId)).toBe(false);
    expect(next.bindings.some((b) => b.controlId === controlId)).toBe(false);
    // Naga controls untouched.
    expect(next.physicalControls.some((c) => c.deviceId === "razer-naga")).toBe(true);

    // Builtin device is never deletable.
    expect(removeDevice(config, "razer-naga")).toBe(config);
    // The last remaining device is never deletable.
    const lastOnly: AppConfig = {
      ...makeConfig(),
      devices: [{ id: "solo", name: "Solo" }],
      physicalControls: [],
    };
    expect(removeDevice(lastOnly, "solo")).toBe(lastOnly);
  });
});
