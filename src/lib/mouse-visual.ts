// Shared, framework-agnostic helpers for the two mouse-layout visualizers
// (`MouseVisualization` photo mode + `MouseVisualizationSvg` schematic mode).
// Extracted so the interaction/label logic lives in one place; behavioural
// differences between the two modes are expressed as explicit options, not
// forked copies.

import i18n from "../i18n";
import { isOfflineLayer, type Action, type AppConfig, type Binding, type ControlId, type Layer, type TriggerMode } from "./config";
import { isBuiltinControl, type OfflinePreview } from "./onboard-mapping";
import { findBinding } from "./config-editing";
import type { Slot } from "./binding-moves";
import type { ControlSurfaceEntry } from "./constants";
import type { ExecutionRecord } from "./runtime";
import { ACTION_CATEGORIES } from "./constants";
import { controlAssignmentLabel, displayNameForControl, fallbackLabel, offlineDetailLabel } from "./labels";

/** Use the same firmware result for the legend and the mouse hotspots. */
export function withOfflineAssignment(config: AppConfig, profileId: string, layer: Layer, entry: ControlSurfaceEntry, preview: OfflinePreview | null): ControlSurfaceEntry {
  if (!isBuiltinControl(config, entry.control.id)) return entry;
  const offlineLayer = isOfflineLayer(layer) ? layer : layer === "hypershift" ? "offlineHypershift" : "offline";
  const result = preview?.controls.find((control) => control.controlId === entry.control.id && control.layer === offlineLayer);
  const action = config.actions.find((action) => action.id === result?.actionId) ?? null;
  if (!isOfflineLayer(layer)) {
    if (!entry.sidearmOnly) return entry;
    return { ...entry, offlineActionLabel: controlAssignmentLabel({ ...entry, action, offline: result ?? { kind: "unknown", editable: false } }) };
  }
  const liveLayer = layer === "offlineHypershift" ? "hypershift" : "standard";
  const live = ([liveLayer, "standard"] as const).map((liveLayer) =>
    findBinding(config, profileId, liveLayer, entry.control.id)).find((binding) => binding?.enabled);
  const liveAction = config.actions.find((action) => action.id === live?.actionId);
  return {
    ...entry,
    binding: findBinding(config, profileId, layer, entry.control.id) ?? null,
    action,
    offline: { ...(result ?? { kind: "unknown", editable: false }), liveAction },
    mapping: null,
    fallback: null,
    isHypershiftTrigger: false,
    isHypershift2Trigger: false,
    extras: undefined,
    sidearmOnly: false,
    inMouse: false,
    syncedWith: undefined,
    sameAs: undefined,
  };
}

export type ViewTab = "top" | "side" | "combined" | "bottom";

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
  /** A layer pill's right-click "Copy assignments…" from that layer; absent = no menu. */
  onCopyLayer?: (layer: Layer) => void;
  /** Layers the pills offer (`deviceLayers`); absent = standard and HyperShift. */
  layers?: readonly Layer[];
  onContextMenu?: (id: ControlId, binding: Binding | null, action: Action | null, x: number, y: number) => void;
  executionCounts?: Map<string, number>;
  executionHistory?: Map<string, ExecutionRecord[]>;
  throttledControlIds?: Set<string>;
  heatmapEnabled?: boolean;
  onDropBinding?: (targetControlId: ControlId, from: Slot, copy: boolean) => void;
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
    case "longPress":
      return "· ⌛";
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
  if (entry.offline) return controlAssignmentLabel(entry);
  if (entry.isHypershiftTrigger) return controlAssignmentLabel(entry);
  if (entry.action && entry.action.type !== "disabled" && entry.binding?.enabled) {
    const base = entry.action.displayName;
    if (!opts.triggerLabels) return base;
    const badge = triggerBadge(entry.binding.triggerMode, opts.triggerLabels);
    return badge ? `${base} ${badge}` : base;
  }
  return fallbackLabel(entry) ?? displayNameForControl(entry.control);
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
  if (entry.offline) return [name, controlAssignmentLabel(entry), offlineDetailLabel(entry)].filter(Boolean).join("\n");
  if (entry.isHypershiftTrigger) return `${name}\n${controlAssignmentLabel(entry)}`;
  if (!entry.action || entry.action.type === "disabled" || !entry.binding?.enabled) {
    return `${name}\n${fallbackLabel(entry) ?? unassignedLabel}`;
  }
  const cat = ACTION_CATEGORIES.find((c) => c.actionType === entry.action!.type);
  const catLabel = cat ? i18n.t(cat.label) : "";
  const inMouse = entry.inMouse ? `\n${i18n.t("offline.inMouseTooltip")}` : "";
  const live = entry.sidearmOnly ? `\n${i18n.t("offline.tooltip", { action: entry.offlineActionLabel ?? i18n.t("offline.silentAction") })}` : "";
  const synced = entry.syncedWith?.length ? `\n${i18n.t("mouseVisual.syncedWith", { mice: entry.syncedWith.join(", ") })}` : "";
  const same = entry.sameAs?.length ? `\n${i18n.t("mouseVisual.sameAs", { buttons: entry.sameAs.join(", ") })}` : "";
  return `${name}\n${catLabel}: ${entry.action.displayName}${extrasText(entry)}${inMouse}${live}${synced}${same}`;
}

/** Tooltip lines for the other press patterns: "Hold: Alt+V". */
function extrasText(entry: ControlSurfaceEntry): string {
  const key = { longPress: "picker.gestureLongPress", doublePress: "picker.gestureDoublePress", triplePress: "picker.gestureTriplePress" } as const;
  return (entry.extras ?? []).map((extra) => `\n${i18n.t(key[extra.gesture])}: ${extra.action.displayName}`).join("");
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

/** The `dataTransfer` type of a dragged button assignment. Its presence (the
 *  data itself is unreadable during dragover) tells drop targets such as the
 *  layer pills and the sidebar profiles that a button is being dragged. */
export const BINDING_DRAG_TYPE = "application/x-sidearm-binding";

/** The `dataTransfer` type of a dragged profile (from the sidebar or a memory slot). */
export const PROFILE_DRAG_TYPE = "application/x-sidearm-profile";

/** The `dataTransfer` type of a dragged onboard memory slot number (1..5). */
export const MEMORY_SLOT_DRAG_TYPE = "application/x-sidearm-memory-slot";

export function isBindingDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(BINDING_DRAG_TYPE);
}

/** Serialize a dragged button (its slot) for `dataTransfer`. */
export function buildBindingDragData(slot: Slot): string {
  return JSON.stringify({ type: "binding", ...slot });
}

/** Parse a binding drag payload; returns the slot or null on any malformed input. */
export function parseBindingDragData(raw: string): Slot | null {
  try {
    const data = JSON.parse(raw) as Partial<Slot> & { type?: string };
    if (data.type === "binding" && typeof data.profileId === "string" && typeof data.layer === "string"
      && typeof data.controlId === "string") {
      return { profileId: data.profileId, layer: data.layer, controlId: data.controlId };
    }
  } catch {
    /* ignore malformed data */
  }
  return null;
}
