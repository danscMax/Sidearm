// Moving, swapping and copying a button's assignments: one slot (profile ·
// layer · control) carries every press pattern of the button, and these edits
// take them all together, so a hidden long or double press never stays behind.

import type { AppConfig, Binding, ControlId, Layer } from "./config";
import { copyBindingBetweenProfiles, makeBindingId, nextUniqueId, removeBinding } from "./config-editing";

export interface Slot {
  profileId: string;
  layer: Layer;
  controlId: ControlId;
}

export type PlaceOutcome = "moved" | "swapped" | "copied" | "none";

const inSlot = (binding: Binding, slot: Slot) =>
  binding.profileId === slot.profileId && binding.layer === slot.layer && binding.controlId === slot.controlId;

const sameSlot = (a: Slot, b: Slot) =>
  a.profileId === b.profileId && a.layer === b.layer && a.controlId === b.controlId;

export function slotBindings(config: AppConfig, slot: Slot): Binding[] {
  return config.bindings.filter((binding) => inSlot(binding, slot));
}

/** A menu's items point at other actions that a copy would share, not clone. */
export function slotHasMenu(config: AppConfig, slot: Slot): boolean {
  const ids = new Set(slotBindings(config, slot).map((binding) => binding.actionId));
  return config.actions.some((action) => ids.has(action.id) && action.type === "menu");
}

/** Move (onto an occupied slot: swap) or copy the assignments of `from` to `to`. */
export function placeSlot(
  config: AppConfig,
  from: Slot,
  to: Slot,
  mode: "move" | "copy",
): { config: AppConfig; outcome: PlaceOutcome } {
  const source = slotBindings(config, from);
  if (source.length === 0 || sameSlot(from, to)) return { config, outcome: "none" };

  if (mode === "copy") {
    // The copy replaces the whole target button, every press pattern of it.
    let next = slotBindings(config, to).reduce((acc, binding) => removeBinding(acc, binding.id), config);
    for (const binding of source) {
      next = copyBindingBetweenProfiles(next, binding.id, to.profileId, to.layer, to.controlId);
    }
    return { config: next, outcome: "copied" };
  }

  const target = slotBindings(config, to);
  const moving = new Set([...source, ...target].map((binding) => binding.id));
  // Fresh ids for the moved bindings: an id is derived from its slot, and a
  // later upsert by id must not hit a binding that now lives elsewhere.
  const taken = new Set(config.bindings.filter((binding) => !moving.has(binding.id)).map((binding) => binding.id));
  const rehome = (binding: Binding, slot: Slot): Binding => {
    const id = nextUniqueId(taken, makeBindingId(slot.profileId, slot.layer, slot.controlId));
    taken.add(id);
    return { ...binding, id, profileId: slot.profileId, layer: slot.layer, controlId: slot.controlId };
  };
  const bindings = config.bindings.map((binding) =>
    inSlot(binding, from) ? rehome(binding, to) : inSlot(binding, to) ? rehome(binding, from) : binding,
  );
  return { config: { ...config, bindings }, outcome: target.length > 0 ? "swapped" : "moved" };
}

/** One row per button of `layer` that any of `profileIds` assigns: what each
 *  profile has there (labels of its press patterns, joined), and whether they differ. */
export function compareProfiles(
  config: AppConfig,
  layer: Layer,
  profileIds: string[],
): { controlId: ControlId; cells: string[]; differs: boolean }[] {
  const controls = [...new Set(config.bindings.filter((b) => b.layer === layer && profileIds.includes(b.profileId)).map((b) => b.controlId))];
  return controls.sort().map((controlId) => {
    const cells = profileIds.map((profileId) =>
      slotBindings(config, { profileId, layer, controlId })
        .filter((binding) => binding.enabled)
        .map((binding) => binding.label)
        .join(" · "),
    );
    return { controlId, cells, differs: new Set(cells).size > 1 };
  });
}

/** Put profile `draggedId` where `targetId` is in the sidebar order (highest
 *  priority first) by renumbering the priorities. */
export function reorderProfiles(config: AppConfig, draggedId: string, targetId: string): AppConfig {
  const order = [...config.profiles]
    .sort((a, b) => b.priority - a.priority || (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((profile) => profile.id);
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return config;
  order.splice(to, 0, ...order.splice(from, 1));
  const priority = new Map(order.map((id, index) => [id, (order.length - index) * 10]));
  return { ...config, profiles: config.profiles.map((profile) => ({ ...profile, priority: priority.get(profile.id) ?? profile.priority })) };
}

/** Copy every assignment of a profile's layer (or of all its layers) into
 *  another profile and/or layer. `replace` false keeps buttons that already
 *  have something there. Menus are skipped (see `slotHasMenu`). */
export function copyAssignments(
  config: AppConfig,
  from: { profileId: string; layer: Layer | "all" },
  to: { profileId: string; layer: Layer | "same" },
  replace: boolean,
): { config: AppConfig; copied: number; kept: number; menus: number } {
  const slots = new Map<string, Slot>();
  for (const binding of config.bindings) {
    if (binding.profileId !== from.profileId || (from.layer !== "all" && binding.layer !== from.layer)) continue;
    slots.set(`${binding.layer}\u0000${binding.controlId}`, { profileId: binding.profileId, layer: binding.layer, controlId: binding.controlId });
  }
  let next = config;
  let copied = 0;
  let kept = 0;
  let menus = 0;
  for (const source of slots.values()) {
    const target: Slot = { profileId: to.profileId, layer: to.layer === "same" ? source.layer : to.layer, controlId: source.controlId };
    if (sameSlot(source, target)) continue;
    if (slotHasMenu(next, source)) { menus += 1; continue; }
    if (!replace && slotBindings(next, target).length > 0) { kept += 1; continue; }
    next = placeSlot(next, source, target, "copy").config;
    copied += 1;
  }
  return { config: next, copied, kept, menus };
}
