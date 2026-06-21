// Shared, framework-agnostic helpers for the two mouse-layout visualizers
// (`MouseVisualization` photo mode + `MouseVisualizationSvg` schematic mode).
// Extracted so the interaction/label logic lives in one place; behavioural
// differences between the two modes are expressed as explicit options, not
// forked copies.

import i18n from "../i18n";
import type { Action, Binding, ControlId, Layer, TriggerMode } from "./config";
import type { ControlSurfaceEntry } from "./constants";
import { ACTION_CATEGORIES } from "./constants";
import { displayNameForControl } from "./labels";

export type ViewTab = "top" | "side" | "combined";

/**
 * Shared prop contract for both mouse-layout visualizers (photo + schematic).
 * Declared once here so the schematic view can't silently drift from the photo
 * view — e.g. omitting `matchedControlIds`/`conflictBindingIds` and losing the
 * search-dim / conflict-highlight overlays.
 */
export interface MouseVisualizationProps {
  entries: ControlSurfaceEntry[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  /** If set, controls not in the set are visually dimmed. Null = no filter. */
  matchedControlIds?: Set<ControlId> | null;
  /** Binding IDs that conflict with another binding on the same layer. */
  conflictBindingIds?: Set<string>;
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
  onOpenActionPicker: (id: ControlId, binding: Binding | null) => void;
  onSelectLayer: (layer: Layer) => void;
  onContextMenu?: (id: ControlId, binding: Binding | null, action: Action | null, x: number, y: number) => void;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
  onDropBinding?: (targetControlId: ControlId, sourceActionId: string) => void;
}

/** Localized short labels for the trigger-mode badges that carry words. */
export interface TriggerBadgeLabels {
  hold: string;
  chord: string;
}

/**
 * Trigger-mode suffix shown after an action label (photo mode only).
 * `2×`/`3×` are language-neutral; hold/chord come from the caller's locale.
 */
export function triggerBadge(mode: TriggerMode | undefined, labels: TriggerBadgeLabels): string {
  switch (mode) {
    case "doublePress":
      return "· 2×";
    case "triplePress":
      return "· 3×";
    case "hold":
      return `· ${labels.hold}`;
    case "chord":
      return `· ${labels.chord}`;
    case "press":
    case undefined:
      return "";
    default:
      // Exhaustiveness guard: a new TriggerMode must add a case above.
      void (mode satisfies never);
      return "";
  }
}

/**
 * Primary label for a control cell. When `triggerLabels` is supplied (photo
 * mode) an enabled binding's trigger-mode badge is appended; without it
 * (schematic mode) only the bare action label is shown.
 */
export function actionLabel(
  entry: ControlSurfaceEntry,
  opts: { triggerLabels?: TriggerBadgeLabels } = {},
): string {
  if (entry.action && entry.action.type !== "disabled" && entry.binding?.enabled) {
    const base = entry.action.displayName;
    if (!opts.triggerLabels) return base;
    const badge = triggerBadge(entry.binding.triggerMode, opts.triggerLabels);
    return badge ? `${base} ${badge}` : base;
  }
  return displayNameForControl(entry.control);
}

/**
 * Heatmap opacity for a control's execution count: a 0.35 floor scaled up to
 * 1.0 by the count's share of the busiest control. Shared by the DOM badge
 * (`HeatCount`) and the SVG `<text>` count so both modes stay in sync.
 */
export function heatIntensity(count: number, counts: Map<string, number>): number {
  const maxCount = Math.max(1, ...Array.from(counts.values()));
  const intensity = Math.min(count / maxCount, 1);
  return 0.35 + intensity * 0.65;
}

/** Heatmap background tint for an executed control (shared by the DOM tint and SVG fill). */
export const HEAT_TINT = "rgba(159, 202, 105, 0.07)";

/** Two-line tooltip text: control name + assignment (or the unassigned label). */
export function tooltipText(entry: ControlSurfaceEntry, unassignedLabel: string): string {
  const name = displayNameForControl(entry.control);
  if (!entry.action || entry.action.type === "disabled" || !entry.binding?.enabled) {
    return `${name}\n${unassignedLabel}`;
  }
  const cat = ACTION_CATEGORIES.find((c) => c.actionType === entry.action!.type);
  const catLabel = cat ? i18n.t(cat.label) : "";
  return `${name}\n${catLabel}: ${entry.action.displayName}`;
}

/** className for a `btn-legend__cell` button. `dimmed`/`conflict` apply in photo mode only. */
export function legendCellClass(flags: {
  selected: boolean;
  hovered: boolean;
  dragOver: boolean;
  dimmed?: boolean;
  conflict?: boolean;
}): string {
  return (
    "btn-legend__cell" +
    (flags.selected ? " btn-legend__cell--selected" : "") +
    (flags.hovered ? " btn-legend__cell--hovered" : "") +
    (flags.dragOver ? " mouse-visual__hotspot--dragover" : "") +
    (flags.dimmed ? " btn-legend__cell--dimmed" : "") +
    (flags.conflict ? " btn-legend__cell--conflict" : "")
  );
}

/** Serialize a binding drag payload for `dataTransfer`. */
export function buildBindingDragData(actionId: string): string {
  return JSON.stringify({ type: "binding", actionId });
}

/** Parse a binding drag payload; returns the actionId or null on any malformed input. */
export function parseBindingDragData(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { type?: string; actionId?: string };
    if (data.type === "binding" && typeof data.actionId === "string") {
      return data.actionId;
    }
  } catch {
    /* ignore malformed data */
  }
  return null;
}

/* ── Legend column button lists (shared between both modes) ── */

export const TOP_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
];

export const TOP_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "mouse_5", "wheel_down",
];

export const COMBINED_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
  "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
];

export const COMBINED_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "wheel_down", "mouse_5",
  "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
];
