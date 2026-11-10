import type { Action, AppConfig, Binding, ControlId, Layer } from "./config";
import { gestureOf, makeRandomId } from "./config-editing";
import { deviceControlId, deviceLayout, layoutControlId } from "./devices";

/**
 * Copying assignments from one built-in mouse to another: a binding moves to
 * the control in the same place on the other mouse (the shared layout id,
 * `thumb_01` ↔ `v3_thumb_01`). The V2 config calls its wheel tilt
 * `mouse_4`/`mouse_5` (its factory function), the V3 `wheel_left`/`wheel_right`,
 * so those two pairs translate too. Each copy gets its own action,
 * so editing one mouse never changes the other.
 */
const EQUIVALENT: Readonly<Record<ControlId, ControlId>> = {
  mouse_4: "wheel_left",
  mouse_5: "wheel_right",
  wheel_left: "mouse_4",
  wheel_right: "mouse_5",
};

/** What to do when the target control already has a binding there. */
export type TransferConflict = "keep" | "replace";

export interface TransferItem {
  binding: Binding;
  /** Target control, when there is one. */
  target: ControlId | null;
  outcome: "copy" | "replace" | "noMatch" | "occupied";
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
      if (occupant(config, binding.profileId, binding.layer, target, binding)) {
        return { binding, target, outcome: conflict === "replace" ? "replace" as const : "occupied" as const };
      }
      return { binding, target, outcome: "copy" as const };
    });
}

/** Applies a plan from {@link planDeviceTransfer}. */
export function applyDeviceTransfer(config: AppConfig, fromDevice: string, toDevice: string, plan: readonly TransferItem[]): AppConfig {
  const moving = plan.filter((item) => item.target && (item.outcome === "copy" || item.outcome === "replace"));
  const replaced = new Set(
    moving
      .filter((item) => item.outcome === "replace")
      .map((item) => occupant(config, item.binding.profileId, item.binding.layer, item.target!, item.binding)?.id),
  );
  const clonedActions = new Map<string, Action>();
  const copies: Binding[] = moving.map(({ binding, target }) => {
    let action = clonedActions.get(binding.actionId);
    const source = config.actions.find((entry) => entry.id === binding.actionId);
    if (!action && source) {
      action = { ...structuredClone(source), id: makeRandomId("action") };
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
    ],
  };
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
