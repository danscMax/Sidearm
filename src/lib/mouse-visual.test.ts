import { describe, expect, it } from "vitest";
import type { Action, Binding, PhysicalControl } from "./config";
import type { ControlSurfaceEntry } from "./constants";
import {
  actionLabel,
  buildBindingDragData,
  heatIntensity,
  legendCellClass,
  parseBindingDragData,
  tooltipText,
  triggerBadge,
} from "./mouse-visual";

const LABELS = { hold: "Hold", chord: "Chord" };

const control = { id: "thumb_01", defaultName: "Thumb 1" } as unknown as PhysicalControl;

function assignedEntry(triggerMode?: string): ControlSurfaceEntry {
  return {
    control,
    binding: { id: "b1", enabled: true, triggerMode } as unknown as Binding,
    action: { id: "a1", type: "shortcut", displayName: "Ctrl+C" } as unknown as Action,
    mapping: null,
    isSelected: false,
  };
}

const unassignedEntry: ControlSurfaceEntry = {
  control,
  binding: null,
  action: null,
  mapping: null,
  isSelected: false,
};

describe("triggerBadge", () => {
  it("maps known modes", () => {
    expect(triggerBadge("doublePress", LABELS)).toBe("· 2×");
    expect(triggerBadge("triplePress", LABELS)).toBe("· 3×");
    expect(triggerBadge("hold", LABELS)).toBe("· Hold");
    expect(triggerBadge("chord", LABELS)).toBe("· Chord");
  });
  it("uses the supplied locale labels for hold/chord", () => {
    const ru = { hold: "Удержание", chord: "Аккорд" };
    expect(triggerBadge("hold", ru)).toBe("· Удержание");
    expect(triggerBadge("chord", ru)).toBe("· Аккорд");
  });
  it("returns empty for plain press / undefined", () => {
    expect(triggerBadge("press", LABELS)).toBe("");
    expect(triggerBadge(undefined, LABELS)).toBe("");
  });
});

describe("actionLabel", () => {
  it("appends the trigger badge only when triggerLabels is supplied (photo vs schematic)", () => {
    expect(actionLabel(assignedEntry("hold"), { triggerLabels: LABELS })).toBe("Ctrl+C · Hold");
    expect(actionLabel(assignedEntry("hold"))).toBe("Ctrl+C"); // schematic: no badge
  });
  it("omits the badge when the trigger mode has none", () => {
    expect(actionLabel(assignedEntry("press"), { triggerLabels: LABELS })).toBe("Ctrl+C");
    expect(actionLabel(assignedEntry(undefined), { triggerLabels: LABELS })).toBe("Ctrl+C");
  });
  it("falls back to the control name when unassigned", () => {
    const label = actionLabel(unassignedEntry, { triggerLabels: LABELS });
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("heatIntensity", () => {
  it("returns full opacity when the control is the busiest", () => {
    expect(heatIntensity(10, new Map([["a", 10]]))).toBeCloseTo(1);
  });
  it("scales between the 0.35 floor and 1 by share of the max", () => {
    const counts = new Map([["a", 10], ["b", 5]]);
    expect(heatIntensity(5, counts)).toBeCloseTo(0.35 + 0.5 * 0.65);
    expect(heatIntensity(10, counts)).toBeCloseTo(1);
  });
  it("never divides by zero when every count is zero", () => {
    expect(heatIntensity(0, new Map([["a", 0]]))).toBeCloseTo(0.35);
  });
});

describe("tooltipText", () => {
  it("puts the assignment on a second line when assigned", () => {
    const text = tooltipText(assignedEntry("hold"), "Unassigned");
    expect(text).toContain("\n");
    expect(text).toContain("Ctrl+C");
  });
  it("shows the unassigned label when not assigned", () => {
    expect(tooltipText(unassignedEntry, "Unassigned")).toContain("Unassigned");
  });
});

describe("legendCellClass", () => {
  it("returns the base class with no flags", () => {
    expect(legendCellClass({ selected: false, hovered: false, dragOver: false })).toBe(
      "btn-legend__cell",
    );
  });
  it("adds a modifier per active flag", () => {
    expect(legendCellClass({ selected: true, hovered: false, dragOver: false })).toContain(
      "btn-legend__cell--selected",
    );
    expect(legendCellClass({ selected: false, hovered: true, dragOver: false })).toContain(
      "btn-legend__cell--hovered",
    );
    // drag-over reuses the hotspot modifier, not a btn-legend one.
    expect(legendCellClass({ selected: false, hovered: false, dragOver: true })).toContain(
      "mouse-visual__hotspot--dragover",
    );
    expect(
      legendCellClass({ selected: false, hovered: false, dragOver: false, dimmed: true }),
    ).toContain("btn-legend__cell--dimmed");
    expect(
      legendCellClass({ selected: false, hovered: false, dragOver: false, conflict: true }),
    ).toContain("btn-legend__cell--conflict");
  });
  it("omits dimmed/conflict when undefined (schematic mode)", () => {
    const cls = legendCellClass({ selected: true, hovered: true, dragOver: false });
    expect(cls).not.toContain("dimmed");
    expect(cls).not.toContain("conflict");
  });
});

describe("binding drag payload", () => {
  it("round-trips an actionId", () => {
    expect(parseBindingDragData(buildBindingDragData("act-42"))).toBe("act-42");
  });
  it("rejects a non-binding payload", () => {
    expect(parseBindingDragData(JSON.stringify({ type: "other", actionId: "x" }))).toBeNull();
  });
  it("rejects malformed JSON / empty input", () => {
    expect(parseBindingDragData("{not json")).toBeNull();
    expect(parseBindingDragData("")).toBeNull();
  });
  it("rejects a binding payload without a string actionId", () => {
    expect(parseBindingDragData(JSON.stringify({ type: "binding" }))).toBeNull();
  });
});
