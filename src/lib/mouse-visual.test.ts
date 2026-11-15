import { describe, expect, it } from "vitest";
import type { Action, Binding, OfflineLayer, PhysicalControl } from "./config";
import i18n from "../i18n";
import { makeConfig, makeAction } from "./test-fixtures";
import type { OfflineControl, OfflinePreview } from "./onboard-mapping";
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
  const live: Binding = { id: "live", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: text.id, label: "Greeting", enabled: true };
  const config = makeConfig({ actions: [shortcut, text], bindings: [live] });
  const base = { ...unassignedEntry, isHypershiftTrigger: true, extras: [{ gesture: "longPress" as const, action: text }], sameAs: ["Other"] };
  const preview = (layer: OfflineLayer, control: Partial<OfflineControl>): OfflinePreview => ({
    target: { state: "written" }, controls: [{ controlId: "thumb_01", layer, kind: "preserved", editable: true, ...control }],
  });

  it.each<OfflineLayer>(["offline", "offlineHypershift"])("renders the planner result on %s without deciding playability", (layer) => {
    const entry = withOfflineAssignment(config, "p1", layer, base, preview(layer, { kind: "inherited", actionId: text.id }));
    expect(entry.offline?.kind).toBe("inherited");
    expect(entry.binding).toBeNull();
    expect(entry.isHypershiftTrigger).toBe(false);
    expect(entry.extras).toBeUndefined();
    expect(entry.sameAs).toBeUndefined();
    expect(actionLabel(entry)).toBe("Greeting");
    expect(tooltipText(entry, "Native")).toContain(i18n.t("offline.inherited"));
    expect(buildHotspotTooltip(entry, layer, undefined, 55)).not.toContain("55");
  });

  it.each([
    [{ kind: "own", actionId: "a1" }, "Ctrl+C"],
    [{ kind: "preserved", native: "mouseBack" }, i18n.t("mouseAction.mouseBack")],
    [{ kind: "preserved" }, i18n.t("offline.preserved")],
    [{ kind: "silent", actionId: "a1" }, i18n.t("offline.silent")],
    [{ kind: "role", role: "hypershift", editable: false }, i18n.t("offline.role.hypershift")],
    [{ kind: "role", role: "profileButton", editable: false }, i18n.t("offline.role.profileButton")],
    [{ kind: "role", role: "nativeClick", editable: false }, i18n.t("offline.role.nativeClick")],
    [{ kind: "unavailable", editable: false }, i18n.t("offline.unavailable")],
  ] satisfies [Partial<OfflineControl>, string][])("labels preview %j", (control, label) => {
    const entry = withOfflineAssignment(config, "p1", "offline", base, preview("offline", control));
    expect(actionLabel(entry)).toBe(label);
    expect(tooltipText(entry, "Native")).toContain(label);
    expect(buildHotspotTooltip(entry, "offline", undefined, 0)).toContain(label);
    if (control.kind === "silent") expect(tooltipText(entry, "")).toContain(i18n.t("offline.liveAction", { action: "Greeting" }));
  });

  it("shows unknown for missing preview/controls", () => {
    for (const value of [null, { target: { state: "unknown" as const }, controls: [] }]) {
      const entry = withOfflineAssignment(config, "p1", "offline", base, value);
      expect(actionLabel(entry)).toBe(i18n.t("offline.unknownAction"));
      expect(entry.offline?.editable).toBe(false);
    }
  });

  it.each(["en", "ru"])('shows short reasons and complete tooltip sentences in %s', async (language) => {
    const previous = i18n.language;
    await i18n.changeLanguage(language);
    try {
      for (const reason of ["actionType", "gesture", "key", "mouseModifiers", "noTrigger"] as const) {
        const entry = withOfflineAssignment(config, "p1", "offline", base, preview("offline", {
          kind: reason === "noTrigger" ? "unavailable" : "silent", reason, liveActionType: "textSnippet",
        }));
        const options = { type: i18n.t("action.type.textSnippet") };
        expect(actionLabel(entry)).toContain(i18n.t(`offline.reason.${reason}`, options));
        expect(tooltipText(entry, "")).toContain(i18n.t(`offline.reason.${reason}Full`, options));
        expect(buildHotspotTooltip(entry, "offline", undefined, 0)).toContain(i18n.t(`offline.reason.${reason}Full`, options));
      }
    } finally { await i18n.changeLanguage(previous); }
  });

  it("does not describe a disabled live binding as an action in Sidearm", () => {
    const disabled = { ...config, bindings: [{ ...live, enabled: false }] };
    const entry = withOfflineAssignment(disabled, "p1", "offline", base, preview("offline", { kind: "silent" }));
    expect(entry.offline?.liveAction).toBeUndefined();
    expect(tooltipText(entry, "")).not.toContain("Greeting");
  });

  it.each<OfflineLayer>(["offline", "offlineHypershift"])("uses the %s preview for the live S tooltip", (layer) => {
    const liveLayer = layer === "offline" ? "standard" : "hypershift";
    const entry = { ...base, isHypershiftTrigger: false, binding: live, action: text, sidearmOnly: true };
    const own = withOfflineAssignment(config, "p1", liveLayer, entry, preview(layer, { kind: "own", actionId: shortcut.id }));
    expect(tooltipText(own, "")).toContain(i18n.t("offline.tooltip", { action: "Ctrl+C" }));
    const native = withOfflineAssignment(config, "p1", liveLayer, entry, preview(layer, { kind: "preserved", native: "mouseBack" }));
    expect(native.offlineActionLabel).toBe(i18n.t("mouseAction.mouseBack"));
    expect(withOfflineAssignment(config, "p1", liveLayer, entry, null).offlineActionLabel).toBe(i18n.t("offline.unknownAction"));
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
