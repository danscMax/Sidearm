import { describe, expect, it } from "vitest";
import type { Action, Binding, OfflineLayer, PhysicalControl } from "./config";
import i18n from "../i18n";
import { makeConfig, makeAction } from "./test-fixtures";
import { setOfflineAssignment } from "./config-editing";
import type { ControlSurfaceEntry } from "./constants";
import { buildHotspotTooltip } from "./labels";
import { COMBINED_RIGHT_BUTTONS, TOP_RIGHT_BUTTONS } from "./devices";
import {
  actionLabel,
  buildBindingDragData,
  heatIntensity,
  legendCellClass,
  parseBindingDragData,
  tooltipText,
  triggerBadge,
  withOfflineAssignment,
} from "./mouse-visual";

const LABELS = { hold: "Hold", chord: "Chord" };

describe("physical right button and configured HyperShift", () => {
  it("uses the real right button rather than the legacy synthetic HS control", () => {
    expect(TOP_RIGHT_BUTTONS).toContain("mouse_right");
    expect(COMBINED_RIGHT_BUTTONS).toContain("mouse_right");
    expect(TOP_RIGHT_BUTTONS).not.toContain("hypershift_button");
  });
  it("shows the configured modifier role instead of a stale stored assignment", () => {
    const entry = { ...assignedEntry(), isHypershiftTrigger: true };
    expect(actionLabel(entry)).toBe("HyperShift · удержание");
    expect(tooltipText(entry, "Native")).toContain("HyperShift · удержание");
    expect(buildHotspotTooltip({ ...entry, binding: { ...entry.binding!, triggerMode: "press" } }, "standard", undefined, 0)).toContain("Держать, пока зажата");
    expect(actionLabel({ ...entry, isHypershiftTrigger: false })).toBe("Ctrl+C");
  });
});

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

describe("offline surface entries", () => {
  const shortcut = makeAction({ type: "shortcut", displayName: "Ctrl+C", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } });
  const text = makeAction({ id: "text", type: "textSnippet", displayName: "Greeting", payload: { source: "inline", text: "Hello", pasteMode: "clipboardPaste", tags: [] } });
  const live = { id: "live", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: shortcut.id, label: "Copy", enabled: true } satisfies Binding;
  const base = { ...unassignedEntry, isHypershiftTrigger: true, extras: [{ gesture: "longPress" as const, action: text }], sameAs: ["Other"] };

  it.each<OfflineLayer>(["offline", "offlineHypershift"])("shows playable inheritance on %s without editing the live binding", (layer) => {
    const config = makeConfig({ actions: [shortcut], bindings: [live] });
    const entry = withOfflineAssignment(config, "p1", layer, base);
    expect(entry.offline?.kind).toBe("inherited");
    expect(entry.binding).toBeNull();
    expect(entry.isHypershiftTrigger).toBe(false);
    expect(entry.extras).toBeUndefined();
    expect(entry.sameAs).toBeUndefined();
    expect(actionLabel(entry)).toBe("Ctrl+C");
    expect(tooltipText(entry, "Native")).toContain(i18n.t("offline.inherited"));
    expect(buildHotspotTooltip(entry, layer, undefined, 55)).toContain("Ctrl+C");
    expect(buildHotspotTooltip(entry, layer, undefined, 55)).not.toContain("55");
  });

  it("shows own assignments and explicit silence, preserving the live action as context", () => {
    const config = makeConfig({ actions: [shortcut], bindings: [live] });
    const own = withOfflineAssignment(setOfflineAssignment(config, "p1", "thumb_01", "offline", { action: "middleClick" }), "p1", "offline", base);
    expect(own.offline?.kind).toBe("own");
    expect(own.binding?.layer).toBe("offline");
    expect(actionLabel(own)).toBe(own.action?.displayName);
    expect(tooltipText(own, "Native")).toContain(i18n.t("offline.own"));
    const silent = withOfflineAssignment(setOfflineAssignment(config, "p1", "thumb_01", "offline", "silent"), "p1", "offline", base);
    expect(silent.offline?.kind).toBe("silent");
    expect(actionLabel(silent)).toBe(i18n.t("offline.silent"));
    expect(tooltipText(silent, "Native")).toContain(i18n.t("offline.liveAction", { action: "Ctrl+C" }));
  });

  it("shows unsupported live actions as silent and honors HyperShift before Standard", () => {
    const config = makeConfig({ actions: [shortcut, text], bindings: [live, { ...live, id: "hs", layer: "hypershift", actionId: text.id }] });
    const entry = withOfflineAssignment(config, "p1", "offlineHypershift", base);
    expect(entry.offline).toEqual({ kind: "silent", liveAction: text });
    expect(actionLabel(entry)).toBe(i18n.t("offline.silent"));
    expect(buildHotspotTooltip(entry, "offlineHypershift", undefined, 0)).toContain("Greeting");
    const empty = withOfflineAssignment(makeConfig(), "p1", "offline", base);
    expect(empty.offline?.liveAction).toBeUndefined();
    expect(tooltipText(empty, "Native")).not.toContain(i18n.t("offline.liveAction", { action: "" }));
  });

  it("gives live S marks the matching firmware override or silence", () => {
    const config = makeConfig({ actions: [text], bindings: [{ ...live, actionId: text.id }] });
    const entry = { ...base, isHypershiftTrigger: false, binding: config.bindings[0], action: text, sidearmOnly: true };
    const silent = withOfflineAssignment(config, "p1", "standard", entry);
    expect(tooltipText(silent, "Native")).toContain(i18n.t("offline.tooltip", { action: i18n.t("offline.silentAction") }));
    const changed = setOfflineAssignment(config, "p1", "thumb_01", "offline", shortcut.payload as Extract<Action, { type: "shortcut" }>["payload"]);
    const own = changed.bindings.find((binding) => binding.layer === "offline")!;
    const ownAction = changed.actions.find((action) => action.id === own.actionId)!;
    expect(withOfflineAssignment(changed, "p1", "standard", entry).offlineActionLabel).toBe(ownAction.displayName);
    const hs = setOfflineAssignment(changed, "p1", "thumb_01", "offlineHypershift", { action: "middleClick" });
    const hsOwn = hs.bindings.find((binding) => binding.layer === "offlineHypershift")!;
    expect(withOfflineAssignment(hs, "p1", "hypershift", entry).offlineActionLabel).toBe(hs.actions.find((action) => action.id === hsOwn.actionId)?.displayName);
  });
});

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
  const slot = { profileId: "p1", layer: "hypershift2" as const, controlId: "thumb_03" };
  it("round-trips a slot", () => {
    expect(parseBindingDragData(buildBindingDragData(slot))).toEqual(slot);
  });
  it("rejects a non-binding payload", () => {
    expect(parseBindingDragData(JSON.stringify({ ...slot, type: "other" }))).toBeNull();
  });
  it("rejects malformed JSON / empty input", () => {
    expect(parseBindingDragData("{not json")).toBeNull();
    expect(parseBindingDragData("")).toBeNull();
  });
  it("rejects a binding payload without its slot", () => {
    expect(parseBindingDragData(JSON.stringify({ type: "binding", actionId: "a" }))).toBeNull();
  });
});
