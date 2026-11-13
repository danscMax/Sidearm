// Statistics from the daily press log (`press_log.rs`): what is pressed most,
// what never, how many keystrokes the mouse saved, which HyperShift actions are
// pressed often enough to deserve a hold, the heat of each button per layer and
// the menu items nobody picked.

import type { PressDay } from "./backend";
import type { Action, AppConfig, Binding, ControlId, Layer, MenuItem } from "./config";
import { findBinding, gestureOf } from "./config-editing";

export type PressLog = Record<string, PressDay>;

/** Counts summed over a period. */
export interface PressSums {
  slots: Map<string, number>;
  actions: Map<string, number>;
}

/** YYYY-MM-DD in local time (as the backend dates its days). */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The `days` days ending `endsDaysAgo` days before `today` (0 = including today). */
export function sumDays(log: PressLog, days: number, today: Date, endsDaysAgo = 0): PressSums {
  const sums: PressSums = { slots: new Map(), actions: new Map() };
  for (let back = endsDaysAgo; back < endsDaysAgo + days; back += 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const day = log[localDate(date)];
    if (!day) continue;
    for (const [key, n] of Object.entries(day.slots ?? {})) sums.slots.set(key, (sums.slots.get(key) ?? 0) + n);
    for (const [key, n] of Object.entries(day.actions ?? {})) sums.actions.set(key, (sums.actions.get(key) ?? 0) + n);
  }
  return sums;
}

/** The log's place key of a binding (`press_log::slot_key`). */
export function slotKey(binding: Binding): string {
  return `${binding.profileId}|${binding.layer}|${binding.controlId}|${gestureOf(binding.triggerMode)}`;
}

/** A device's enabled bindings of one profile on the layers it presses. */
function placesOf(config: AppConfig, profileId: string, deviceId: string): Binding[] {
  const onDevice = new Set(config.physicalControls.filter((c) => c.deviceId === deviceId).map((c) => c.id));
  return config.bindings.filter((b) => b.enabled && b.profileId === profileId && onDevice.has(b.controlId));
}

export interface PlaceCount {
  binding: Binding;
  count: number;
  /** The same period before: for "more / less than last time". */
  before: number;
}

/** The profile's places on a mouse by presses, most first (only pressed ones). */
export function topPlaces(config: AppConfig, now: PressSums, before: PressSums, profileId: string, deviceId: string): PlaceCount[] {
  return placesOf(config, profileId, deviceId)
    .map((binding) => ({ binding, count: now.slots.get(slotKey(binding)) ?? 0, before: before.slots.get(slotKey(binding)) ?? 0 }))
    .filter((place) => place.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Wheel scrolling: never in the log (`press_log`), so never "unused" either. */
const SCROLLS = new Set(["scrollUp", "scrollDown", "scrollLeft", "scrollRight"]);

/** The profile's assignments on a mouse never pressed in the period. */
export function unusedPlaces(config: AppConfig, now: PressSums, profileId: string, deviceId: string): Binding[] {
  const actions = new Map(config.actions.map((action) => [action.id, action]));
  return placesOf(config, profileId, deviceId).filter((binding) => {
    const action = actions.get(binding.actionId);
    const scroll = action?.type === "mouseAction" && SCROLLS.has(action.payload.action);
    return !now.slots.get(slotKey(binding)) && action?.type !== "disabled" && !scroll;
  });
}

/** Keys one run of an action stands for: the characters a text types (+ its
 *  Enter), a shortcut's keys. A click stands for nothing. */
export function keystrokesOf(action: Action | undefined, library: Map<string, string>): number {
  if (!action) return 0;
  switch (action.type) {
    case "shortcut": {
      const p = action.payload;
      return [p.ctrl, p.shift, p.alt, p.win].filter(Boolean).length + (p.key.trim() ? 1 : 0);
    }
    case "textSnippet":
      return [...(action.payload.source === "inline" ? action.payload.text : library.get(action.payload.snippetId) ?? "")].length;
    case "sequence":
      return action.payload.steps.reduce((n, step) => n + (step.type === "text" ? [...step.value].length : step.type === "send" ? 1 : 0), 0);
    default:
      return 0;
  }
}

/** Keys the mouse spared: each run's keystrokes less the one press it took. */
export function savedKeystrokes(config: AppConfig, sums: PressSums): number {
  const actions = new Map(config.actions.map((action) => [action.id, action]));
  const library = new Map(config.snippetLibrary.map((snippet) => [snippet.id, snippet.text]));
  let saved = 0;
  for (const [actionId, runs] of sums.actions) saved += runs * Math.max(0, keystrokesOf(actions.get(actionId), library) - 1);
  return saved;
}

/** HyperShift actions pressed at least `threshold` times whose button has no
 *  long press on the standard layer: a hold would spare the HyperShift. */
export function holdHints(config: AppConfig, sums: PressSums, profileId: string, deviceId: string, threshold = 20): PlaceCount[] {
  return placesOf(config, profileId, deviceId)
    .filter((binding) => binding.layer === "hypershift" && gestureOf(binding.triggerMode) === "press")
    .map((binding) => ({ binding, count: sums.slots.get(slotKey(binding)) ?? 0, before: 0 }))
    .filter((hint) => hint.count >= threshold && !findBinding(config, profileId, "standard", hint.binding.controlId, "longPress"))
    .sort((a, b) => b.count - a.count);
}

/** Presses per control of one profile and layer (all press patterns), for the heat map. */
export function layerHeat(sums: PressSums, profileId: string, layer: Layer): Map<ControlId, number> {
  const heat = new Map<ControlId, number>();
  for (const [key, n] of sums.slots) {
    const [profile, keyLayer, control] = key.split("|");
    if (profile === profileId && keyLayer === layer && control) heat.set(control, (heat.get(control) ?? 0) + n);
  }
  return heat;
}

/** Ids of a menu's items whose action ran 0 times in the period (links to other menus left out). */
export function unpickedItems(items: MenuItem[], sums: PressSums, actions: Map<string, Action>): Set<string> {
  const ids = new Set<string>();
  const walk = (list: MenuItem[]) => list.forEach((item) => {
    if (item.kind === "submenu") walk(item.items);
    else if (actions.get(item.actionId)?.type !== "menu" && !sums.actions.get(item.actionId)) ids.add(item.id);
  });
  walk(items);
  return ids;
}

