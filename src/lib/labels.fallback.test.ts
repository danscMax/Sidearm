import { describe, expect, it } from "vitest";
import type { Action, Binding, PhysicalControl } from "./config";
import { FALLBACK_LAYERS } from "./constants";
import { controlAssignmentLabel, fallbackLabel } from "./labels";
import type { ControlSurfaceEntry } from "./constants/types";

const control = { id: "v3_thumb_01", deviceId: "razer-naga-v3", family: "thumbGrid", defaultName: "Thumb 1", remappable: true, capabilityStatus: "verified" } as PhysicalControl;
const copy: Action = { id: "a1", type: "shortcut", displayName: "Ctrl+C", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } };

function entry(over: Partial<ControlSurfaceEntry>): ControlSurfaceEntry {
  return { control, binding: null, action: null, mapping: null, isSelected: false, ...over };
}

describe("fallback label on HyperShift layers", () => {
  it("names what an empty control plays and from which layer", () => {
    const label = fallbackLabel(entry({ fallback: { action: copy, layer: "standard" } }));
    expect(label).toContain("Ctrl+C");
    expect(controlAssignmentLabel(entry({ fallback: { action: copy, layer: "standard" } }))).toBe(label);
  });

  it("yields to the control's own assignment", () => {
    const binding = { id: "b", profileId: "p", layer: "hypershift2", controlId: control.id, label: "", actionId: "a1", enabled: true } as Binding;
    expect(fallbackLabel(entry({ binding, action: copy, fallback: { action: copy, layer: "standard" } }))).toBeNull();
  });

  it("falls back in the resolver's order", () => {
    expect(FALLBACK_LAYERS.hypershift).toEqual(["standard"]);
    expect(FALLBACK_LAYERS.hypershiftBoth).toEqual([]);
    expect(FALLBACK_LAYERS.hypershift2).toEqual([]);
    expect(FALLBACK_LAYERS.standard).toEqual([]);
  });
});
