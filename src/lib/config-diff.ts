// What changed between two configs, in words, for the "changed outside
// Sidearm" toast (another computer, a script): which buttons got another
// assignment and which menus were edited.

import type { Action, AppConfig, Binding } from "./config";
import { gestureOf } from "./config-editing";
import { controlWithGesture } from "./labels";

/** One binding's content: its fields and its action, minus ids. */
function content(binding: Binding, actions: Map<string, Action>): string {
  const { id: _id, actionId, ...rest } = binding;
  const action = actions.get(actionId);
  // A menu's items are reported as the menu's change, not on every button opening it.
  const body = !action ? null : action.type === "menu" ? { type: action.type, name: action.displayName } : { ...action, id: undefined };
  return JSON.stringify([rest, body]);
}

/** The places ("Profile · Thumb 8 · Hold") whose assignment changed, and the
 *  menus whose items did. */
export function describeConfigChange(previous: AppConfig, next: AppConfig): { places: string[]; menus: string[] } {
  const before = new Map(previous.actions.map((action) => [action.id, action]));
  const after = new Map(next.actions.map((action) => [action.id, action]));
  const slot = (b: Binding) => `${b.profileId}\u0000${b.layer}\u0000${b.controlId}\u0000${gestureOf(b.triggerMode)}`;
  const slots = new Map<string, { old?: Binding; now?: Binding }>();
  for (const binding of previous.bindings) slots.set(slot(binding), { old: binding });
  for (const binding of next.bindings) slots.set(slot(binding), { ...slots.get(slot(binding)), now: binding });
  const profileName = (id: string) => next.profiles.find((p) => p.id === id)?.name ?? previous.profiles.find((p) => p.id === id)?.name ?? id;
  const places = new Set<string>();
  for (const { old, now } of slots.values()) {
    const changed = !old || !now || content(old, before) !== content(now, after);
    const binding = now ?? old!;
    if (changed) places.add(`${profileName(binding.profileId)} · ${controlWithGesture(binding.controlId, binding.triggerMode)}`);
  }
  const menus = next.actions
    .filter((action) => action.type === "menu" && JSON.stringify(before.get(action.id)?.payload) !== JSON.stringify(action.payload))
    .map((action) => action.displayName);
  return { places: [...places], menus };
}
