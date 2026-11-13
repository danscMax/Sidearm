import type { Action, AppConfig, Binding, ControlId, Layer, MenuItem } from "./config";
import { computeReferencedActionIds, gestureOf, makeRandomId, rescueDroppedSnippets } from "./config-editing";
import { deviceControlId, deviceLayout, layoutControlId } from "./devices";
import { cloneMenuItem } from "./menu-arrange";
import { NO_MENU_EDITS } from "./menu-phrase";

/**
 * Copying assignments from one built-in mouse to another: a binding moves to
 * the control in the same place on the other mouse (the shared layout id,
 * `thumb_01` ↔ `v3_thumb_01`). The V2 config calls its wheel tilt
 * `mouse_4`/`mouse_5` (its factory function), the V3 `wheel_left`/`wheel_right`,
 * so those two pairs translate too. Each copy gets its own action (a menu
 * also its own phrases), so editing one mouse never changes the other, unless
 * `shareMenus` keeps one menu for both mice. A HyperShift 2 or HS + HS2
 * binding is left out for a mouse without a HyperShift 2 button.
 */
const EQUIVALENT: Readonly<Record<ControlId, ControlId>> = {
  mouse_4: "wheel_left",
  mouse_5: "wheel_right",
  wheel_left: "mouse_4",
  wheel_right: "mouse_5",
};

/** The place of a control shared by every built-in mouse: its layout id, the
 *  V2's side buttons under the V3's tilt names (`mouse_4` → `wheel_left`). */
export function sharedPlace(controlId: ControlId): ControlId {
  const place = layoutControlId(controlId);
  return place.startsWith("mouse_") && EQUIVALENT[place] ? EQUIVALENT[place]! : place;
}

/** What to do when the target control already has a binding there. */
export type TransferConflict = "keep" | "replace";

export interface TransferItem {
  binding: Binding;
  /** Target control, when there is one. */
  target: ControlId | null;
  outcome: "copy" | "replace" | "noMatch" | "noLayer" | "occupied";
}

/** A control of `deviceId` an action can be put on (not a reserved placeholder). */
function usable(config: AppConfig, id: ControlId, deviceId: string): boolean {
  return config.physicalControls.some((control) => control.id === id && control.deviceId === deviceId && control.remappable);
}

/** The target device's control for a source control, or null. */
function translate(config: AppConfig, fromDevice: string, toDevice: string, controlId: ControlId): ControlId | null {
  const target = deviceLayout(toDevice);
  const source = config.physicalControls.find((control) => control.id === controlId);
  if (!target || source?.deviceId !== fromDevice) return null;
  const layoutId = layoutControlId(controlId);
  const exists = (id: ControlId) => usable(config, id, toDevice);
  for (const candidate of [layoutId, EQUIVALENT[layoutId]]) {
    if (candidate && exists(deviceControlId(target, candidate))) return deviceControlId(target, candidate);
  }
  return null;
}

/** The binding occupying the same slot on the target, if any. */
function occupant(config: AppConfig, profileId: string, layer: Layer, control: ControlId, binding: Binding): Binding | undefined {
  return config.bindings.find((other) =>
    other.profileId === profileId && other.layer === layer && other.controlId === control
    && gestureOf(other.triggerMode) === gestureOf(binding.triggerMode));
}

/** What a copy of these profiles' bindings would do, binding by binding. */
export function planDeviceTransfer(
  config: AppConfig,
  fromDevice: string,
  toDevice: string,
  profileIds: readonly string[],
  conflict: TransferConflict,
): TransferItem[] {
  return config.bindings
    .filter((binding) => profileIds.includes(binding.profileId)
      && config.physicalControls.some((control) => control.id === binding.controlId && control.deviceId === fromDevice))
    .map((binding) => {
      const target = translate(config, fromDevice, toDevice, binding.controlId);
      const partnerOk = !binding.chordPartner || translate(config, fromDevice, toDevice, binding.chordPartner) !== null;
      if (!target || !partnerOk) return { binding, target, outcome: "noMatch" as const };
      if ((binding.layer === "hypershift2" || binding.layer === "hypershiftBoth") && !deviceLayout(toDevice)?.hypershift2Triggers?.length) {
        return { binding, target, outcome: "noLayer" as const };
      }
      if (occupant(config, binding.profileId, binding.layer, target, binding)) {
        return { binding, target, outcome: conflict === "replace" ? "replace" as const : "occupied" as const };
      }
      return { binding, target, outcome: "copy" as const };
    });
}

/** Applies a plan from {@link planDeviceTransfer}. */
export function applyDeviceTransfer(
  config: AppConfig,
  fromDevice: string,
  toDevice: string,
  plan: readonly TransferItem[],
  { shareMenus = false }: { shareMenus?: boolean } = {},
): AppConfig {
  const moving = plan.filter((item) => item.target && (item.outcome === "copy" || item.outcome === "replace"));
  const replaced = new Set(
    moving
      .filter((item) => item.outcome === "replace")
      .map((item) => occupant(config, item.binding.profileId, item.binding.layer, item.target!, item.binding)?.id),
  );
  const clonedActions = new Map<string, Action>();
  const menuPhrases: Action[] = [];
  const copies: Binding[] = moving.map(({ binding, target }) => {
    let action = clonedActions.get(binding.actionId);
    const source = config.actions.find((entry) => entry.id === binding.actionId);
    if (!action && source && !(shareMenus && source.type === "menu")) {
      action = { ...structuredClone(source), id: makeRandomId("action") };
      if (action.type === "menu") {
        // The menu's phrases are copied too, or editing one would change both.
        let edits = NO_MENU_EDITS;
        const items = action.payload.items.map((item) => {
          const copy = cloneMenuItem(config, edits, item, []);
          edits = copy.edits;
          return copy.item;
        });
        action = { ...action, payload: { ...action.payload, items } };
        menuPhrases.push(...Object.values(edits.actions));
      }
      clonedActions.set(binding.actionId, action);
    }
    return {
      ...structuredClone(binding),
      id: makeRandomId("binding"),
      controlId: target!,
      chordPartner: binding.chordPartner ? translate(config, fromDevice, toDevice, binding.chordPartner) ?? undefined : undefined,
      actionId: action?.id ?? binding.actionId,
    };
  });
  const bindings = config.bindings.filter((binding) => !replaced.has(binding.id));
  const used = new Set(bindings.map((binding) => binding.actionId));
  return {
    ...config,
    bindings: [...bindings, ...copies],
    // An action only the replaced bindings used goes with them.
    actions: [
      ...config.actions.filter((action) => used.has(action.id)
        || !config.bindings.some((binding) => binding.actionId === action.id)),
      ...clonedActions.values(),
      ...menuPhrases,
    ],
  };
}

/** A HyperShift 2 assignment of one mouse that the other mouse (without that
 *  layer) can take as a long press of the same button. */
export interface HoldOffer {
  binding: Binding;
  /** The other mouse's control. */
  target: ControlId;
}

/** What of `fromDevice`'s HyperShift 2 layer fits on long presses of
 *  `toDevice` (a mouse without HyperShift 2): plain presses whose button's long
 *  press is free there. */
export function planHoldsFromHypershift2(config: AppConfig, fromDevice: string, toDevice: string, profileIds: readonly string[]): HoldOffer[] {
  if (hasLayer(toDevice, "hypershift2") || !hasLayer(fromDevice, "hypershift2")) return [];
  const onFrom = new Set(config.physicalControls.filter((c) => c.deviceId === fromDevice).map((c) => c.id));
  const actions = new Map(config.actions.map((action) => [action.id, action]));
  return config.bindings.flatMap((binding) => {
    if (!binding.enabled || binding.layer !== "hypershift2" || gestureOf(binding.triggerMode) !== "press"
      || !profileIds.includes(binding.profileId) || !onFrom.has(binding.controlId)
      || !actions.get(binding.actionId) || actions.get(binding.actionId)!.type === "disabled") return [];
    const target = translate(config, fromDevice, toDevice, binding.controlId);
    const taken = target && config.bindings.some((other) => other.profileId === binding.profileId && other.layer === "standard"
      && other.controlId === target && gestureOf(other.triggerMode) === "longPress");
    return target && !taken ? [{ binding, target }] : [];
  });
}

/** Puts the chosen offers on their long presses (the same action). */
export function applyHoldOffers(config: AppConfig, offers: readonly HoldOffer[]): AppConfig {
  const added: Binding[] = offers.map(({ binding, target }) => ({
    ...structuredClone(binding),
    id: makeRandomId("binding"),
    controlId: target,
    layer: "standard",
    triggerMode: "longPress",
    chordPartner: undefined,
  }));
  return { ...config, bindings: [...config.bindings, ...added] };
}

/** Moves imported bindings for controls this config does not have onto the
 *  same places of `toDevice` (a profile exported from another mouse). Returns
 *  the config and how many bindings found no place. */
export function retargetImportedBindings(
  config: AppConfig,
  bindingIds: ReadonlySet<string>,
  toDevice: string,
): { config: AppConfig; dropped: number } {
  const layout = deviceLayout(toDevice);
  const known = (id: ControlId) => config.physicalControls.some((control) => control.id === id);
  const place = (id: ControlId): ControlId | null => {
    if (known(id)) return id;
    if (!layout) return null;
    const layoutId = layoutControlId(id);
    for (const candidate of [layoutId, EQUIVALENT[layoutId]]) {
      const target = candidate ? deviceControlId(layout, candidate) : null;
      if (target && usable(config, target, toDevice)) return target;
    }
    return null;
  };
  let dropped = 0;
  const bindings = config.bindings.flatMap((binding) => {
    if (!bindingIds.has(binding.id) || (known(binding.controlId) && (!binding.chordPartner || known(binding.chordPartner)))) {
      return [binding];
    }
    const controlId = place(binding.controlId);
    const chordPartner = binding.chordPartner ? place(binding.chordPartner) : undefined;
    if (!controlId || chordPartner === null) {
      dropped += 1;
      return [];
    }
    return [{ ...binding, controlId, chordPartner: chordPartner ?? undefined }];
  });
  return { config: { ...config, bindings }, dropped };
}

/* ── Keeping the mice alike (`Settings.syncMice`) ── */

/** Whether a layer exists on a mouse: HyperShift 2 and HS + HS2 need a HyperShift 2 button. */
function hasLayer(deviceId: string, layer: Layer): boolean {
  return (layer !== "hypershift2" && layer !== "hypershiftBoth") || Boolean(deviceLayout(deviceId)?.hypershift2Triggers?.length);
}

/** The binding with its action and, for a menu, its items' actions: what the
 *  button does. Two bindings with the same signature do the same thing. */
function signature(binding: Binding, actions: ReadonlyMap<string, Action>): string {
  const { id: _id, controlId: _control, chordPartner: _partner, actionId, ...rest } = binding;
  const seen = new Set<string>();
  const content = (id: string): unknown => {
    const action = actions.get(id);
    if (!action || seen.has(id)) return id;
    seen.add(id);
    const { id: _own, ...body } = action;
    if (action.type !== "menu") return body;
    const items = (list: MenuItem[]): unknown[] => list.map((item) =>
      item.kind === "submenu" ? { ...item, items: items(item.items) } : { ...item, action: content(item.actionId) });
    return { ...body, payload: { ...action.payload, items: items(action.payload.items) } };
  };
  return JSON.stringify([rest, content(actionId)]);
}

/** Bindings of one mouse by place: profile, layer, press pattern and the
 *  layout id shared by both mice. */
function slotsOf(config: AppConfig, deviceId: string, actions: ReadonlyMap<string, Action>): Map<string, { binding: Binding; sig: string }> {
  const onMouse = new Set(config.physicalControls.filter((control) => control.deviceId === deviceId).map((control) => control.id));
  const slots = new Map<string, { binding: Binding; sig: string }>();
  for (const binding of config.bindings) {
    if (!onMouse.has(binding.controlId)) continue;
    const key = [binding.profileId, binding.layer, gestureOf(binding.triggerMode), sharedPlace(binding.controlId)].join("|");
    slots.set(key, { binding, sig: signature(binding, actions) });
  }
  return slots;
}

/**
 * With `settings.syncMice` on, repeats an edit of one built-in mouse's
 * assignments on the same place of the others: the other mouse's button gets
 * the same action (shared, so a later edit in place reaches both), or loses
 * its binding when it was removed. A place edited on both mice at once (a
 * shared menu) is left as it is; a layer the other mouse lacks is skipped.
 * Actions only the replaced bindings used are dropped (their texts kept).
 */
export function mirrorMouseEdit(previous: AppConfig, next: AppConfig): AppConfig {
  if (!next.settings.syncMice) return next;
  const mice = next.devices.filter((device) => device.builtin && deviceLayout(device.id)).map((device) => device.id);
  if (mice.length < 2) return next;
  const before = new Map(previous.actions.map((action) => [action.id, action]));
  const after = new Map(next.actions.map((action) => [action.id, action]));
  const old = new Map(mice.map((id) => [id, slotsOf(previous, id, before)]));
  const now = new Map(mice.map((id) => [id, slotsOf(next, id, after)]));
  const changed = new Map(mice.map((id) => {
    const keys = new Set([...old.get(id)!.keys(), ...now.get(id)!.keys()]);
    return [id, new Set([...keys].filter((key) => old.get(id)!.get(key)?.sig !== now.get(id)!.get(key)?.sig))];
  }));

  const removed = new Set<string>();
  const added: Binding[] = [];
  for (const from of mice) {
    for (const key of changed.get(from)!) {
      const source = now.get(from)!.get(key)?.binding;
      const sourceControl = source?.controlId ?? old.get(from)!.get(key)!.binding.controlId;
      for (const to of mice) {
        if (to === from || changed.get(to)!.has(key)) continue;
        const occupant = now.get(to)!.get(key)?.binding;
        if (occupant) removed.add(occupant.id);
        if (!source || !hasLayer(to, source.layer)) continue;
        const target = translate(next, from, to, sourceControl);
        const partner = source.chordPartner ? translate(next, from, to, source.chordPartner) : undefined;
        if (!target || partner === null) continue;
        added.push({ ...structuredClone(source), id: occupant?.id ?? makeRandomId("binding"), controlId: target, chordPartner: partner });
      }
    }
  }
  if (removed.size === 0 && added.length === 0) return next;

  const bindings = [...next.bindings.filter((binding) => !removed.has(binding.id)), ...added];
  const wasUsed = computeReferencedActionIds(next.actions, next.bindings);
  const used = computeReferencedActionIds(next.actions, bindings);
  const dropped = next.actions.filter((action) => wasUsed.has(action.id) && !used.has(action.id));
  const kept = next.actions.filter((action) => !dropped.includes(action));
  // A dropped text another action holds (or held before this edit: the other
  // mouse's copy of the text just edited) is not "rescued" into the library.
  const inline = (action: Action) => (action.type === "textSnippet" && action.payload.source === "inline" ? [action.payload.text] : []);
  const texts = new Set([...kept, ...previous.actions.filter((action) => !dropped.some((gone) => gone.id === action.id))].flatMap(inline));
  const orphanTexts = dropped.filter((action) => !(action.type === "textSnippet" && action.payload.source === "inline" && texts.has(action.payload.text)));
  return { ...next, bindings, actions: kept, snippetLibrary: rescueDroppedSnippets(orphanTexts, next.snippetLibrary) };
}
