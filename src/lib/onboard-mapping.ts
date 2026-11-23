import type { Action, ActionType, AppConfig, Binding, ControlId, Layer, OfflineLayer } from "./config";
import { gestureOf } from "./config-editing";
import { deviceLayout } from "./devices";
import { primaryKeyCode } from "./key-names";

/** Mouse actions the firmware plays itself (Rust `mouse_offline::onboard_action`). */
const FIRMWARE_MOUSE = new Set(["leftClick", "rightClick", "middleClick", "mouseBack", "mouseForward", "scrollUp", "scrollDown"]);
// Mirrors mouse_memory::hid_usage_for_vk, including its u8 conversion.
const FIRMWARE_KEYS = new Set([
  0x0D, 0x1B, 0x08, 0x09, 0x20, 0xBD, 0xBB, 0xDB, 0xDD, 0xDC, 0xBA, 0xDE,
  0xC0, 0xBC, 0xBE, 0xBF, 0x14, 0x2C, 0x91, 0x13, 0x2D, 0x24, 0x21, 0x2E,
  0x23, 0x22, 0x27, 0x25, 0x28, 0x26, 0x5D,
]);

/**
 * Whether the mouse plays this binding from its own memory, without Sidearm
 * (mirrors Rust `mouse_offline::binding_action` / `onboard_action`): a plain
 * press — no chord — of a shortcut or of a plain mouse button or scroll. Text,
 * macros, menus, launches and long / double / triple presses need Sidearm.
 */
export function playsWithoutSidearm(binding: Binding, action: Action | null | undefined): boolean {
  if (!action || gestureOf(binding.triggerMode) !== "press" || binding.triggerMode === "chord") return false;
  if (action.type === "shortcut") {
    const p = action.payload;
    if (!p.key.trim()) return p.ctrl || p.shift || p.alt || p.win;
    const code = primaryKeyCode(p.key);
    if (code === null) return false;
    const vk = code & 0xFF;
    return (vk >= 0x41 && vk <= 0x5A) || (vk >= 0x30 && vk <= 0x39)
      || (vk >= 0x70 && vk <= 0x87) || (vk >= 0x60 && vk <= 0x69) || FIRMWARE_KEYS.has(vk);
  }
  return action.type === "mouseAction" && FIRMWARE_MOUSE.has(action.payload.action)
    && !(action.payload.ctrl || action.payload.shift || action.payload.alt || action.payload.win);
}

type HardwarePlayabilityReason =
  | "actionType"
  | "gesture"
  | "chord"
  | "conditions"
  | "throttle"
  | "layer"
  | "hs2Override"
  | "key"
  | "mouseModifiers";

interface HardwarePlayability {
  /** "mouse" = executes natively from mouse flash; "sidearm" = requires Sidearm. */
  location: "mouse" | "sidearm";
  /** Present when location === "sidearm"; names the primary reason. */
  reason?: HardwarePlayabilityReason;
  /** Action type for interpolating the actionType reason. */
  actionType?: ActionType;
}

/**
 * Classifies whether a live assignment on a built-in mouse can play directly
 * from mouse memory ("mouse") or requires running Sidearm ("sidearm") and why.
 */
export function classifyHardwarePlayability(
  config: AppConfig,
  profileId: string,
  layer: Layer,
  controlId: ControlId,
  binding: Binding | null | undefined,
  action: Action | null | undefined,
  opts: { checkHs2?: boolean } = {},
): HardwarePlayability {
  if (!binding || !binding.enabled || !action) {
    return { location: "mouse" };
  }
  if (layer !== "standard" && layer !== "hypershift") {
    return { location: "sidearm", reason: "layer" };
  }
  if (binding.triggerMode === "chord") {
    return { location: "sidearm", reason: "chord" };
  }
  if (gestureOf(binding.triggerMode) !== "press") {
    return { location: "sidearm", reason: "gesture" };
  }
  if (!playsWithoutSidearm(binding, action)) {
    if (action.type === "shortcut") {
      return { location: "sidearm", reason: "key" };
    }
    if (action.type === "mouseAction") {
      return { location: "sidearm", reason: "mouseModifiers" };
    }
    return { location: "sidearm", reason: "actionType", actionType: action.type };
  }
  if (binding.throttleMs && binding.throttleMs > 0) {
    return { location: "sidearm", reason: "throttle" };
  }
  const hasExtraGesture = config.bindings.some(
    (other) =>
      other.id !== binding.id &&
      other.profileId === profileId &&
      (other.layer === layer || (layer === "hypershift" && other.layer === "standard")) &&
      other.controlId === controlId &&
      other.enabled &&
      gestureOf(other.triggerMode) !== "press",
  );
  if (hasExtraGesture) {
    return { location: "sidearm", reason: "gesture" };
  }
  if (action.conditions && action.conditions.length > 0) {
    return { location: "sidearm", reason: "conditions" };
  }
  if (opts.checkHs2) {
    const hasHs2 = config.bindings.some(
      (other) =>
        other.profileId === profileId &&
        other.controlId === controlId &&
        other.enabled &&
        (other.layer === "hypershift2" || other.layer === "hypershiftBoth"),
    );
    if (hasHs2) {
      return { location: "sidearm", reason: "hs2Override" };
    }
  }
  return { location: "mouse" };
}

/** Counts how many enabled assignments of `deviceId` in `profileId`
 *  (Standard + HyperShift) can play from mouse memory vs require Sidearm. */
export function summarizeProfileHardwarePlayability(
  config: AppConfig,
  profileId: string,
  deviceId: string,
  opts: { checkHs2?: boolean } = {},
): { inMouse: number; sidearmOnly: number } {
  const deviceControls = new Set(
    config.physicalControls.filter((c) => c.deviceId === deviceId).map((c) => c.id),
  );
  const actionById = new Map(config.actions.map((a) => [a.id, a]));
  const pressSlots = new Set<string>();
  const gestureOnlySlots = new Set<string>();
  let inMouse = 0;
  let sidearmOnly = 0;
  for (const binding of config.bindings) {
    if (
      binding.profileId !== profileId ||
      !binding.enabled ||
      (binding.layer !== "standard" && binding.layer !== "hypershift") ||
      !deviceControls.has(binding.controlId)
    ) {
      continue;
    }
    const action = actionById.get(binding.actionId);
    if (!action) continue;
    const slotKey = `${binding.layer}:${binding.controlId}`;
    if (gestureOf(binding.triggerMode) !== "press") {
      gestureOnlySlots.add(slotKey);
      continue;
    }
    pressSlots.add(slotKey);
    const status = classifyHardwarePlayability(config, profileId, binding.layer, binding.controlId, binding, action, opts);
    if (status.location === "mouse") inMouse += 1;
    else sidearmOnly += 1;
  }
  for (const slotKey of gestureOnlySlots) {
    if (!pressSlots.has(slotKey)) sidearmOnly += 1;
  }
  return { inMouse, sidearmOnly };
}

type HybridBankBlocker =
  | "dedicatedOffline"
  | "singleUserBank"
  | "keySignalsMode"
  | "hs2Trigger"
  | "noNativeKeys";

interface HybridBankStatus {
  /** Whether hybrid mode will actually activate for this profile/slot. */
  willActivate: boolean;
  /** Number of Standard/HyperShift assignments that execute natively from mouse flash. */
  nativeCount: number;
  /** Number of Standard/HyperShift assignments that still run through Sidearm. */
  sidearmCount: number;
  /** Primary reason why hybrid mode will not activate. */
  blocker?: HybridBankBlocker;
}

/** Evaluates whether Hybrid Hardware Bank mode will activate for `profileId`
 *  on a bank mouse (`deviceId`) and returns transparent counts and blockers
 *  matching Rust `mouse_offline::hybrid_native_action` and `live_overlay::profile_uses_hardware_bank`. */
export function evaluateHybridBankStatus(
  config: AppConfig,
  profileId: string,
  deviceId: string,
  ctx: {
    isDedicatedOffline: boolean;
    userBankCount: number;
    consumerSignals: boolean | null;
    allUserBanksHybrid?: boolean;
  },
): HybridBankStatus {
  const profile = config.profiles.find((p) => p.id === profileId);
  const deviceControls = new Set(
    config.physicalControls.filter((c) => c.deviceId === deviceId).map((c) => c.id),
  );
  const prefix = deviceLayout(deviceId)?.controlPrefix ?? "";
  const hasProfileHs2Trigger = Boolean(
    profile?.hypershift2Triggers?.some(
      (trigger) => deviceControls.has(trigger) || (prefix !== "" && trigger.startsWith(prefix)),
    ),
  );
  const rawCounts = summarizeProfileHardwarePlayability(config, profileId, deviceId, { checkHs2: true });
  const counts = hasProfileHs2Trigger
    ? { inMouse: 0, sidearmOnly: rawCounts.inMouse + rawCounts.sidearmOnly }
    : rawCounts;
  if (ctx.isDedicatedOffline) {
    return { willActivate: false, nativeCount: counts.inMouse, sidearmCount: counts.sidearmOnly, blocker: "dedicatedOffline" };
  }
  if (ctx.userBankCount <= 1 || ctx.allUserBanksHybrid) {
    return { willActivate: false, nativeCount: counts.inMouse, sidearmCount: counts.sidearmOnly, blocker: "singleUserBank" };
  }
  if (ctx.consumerSignals === false) {
    return { willActivate: false, nativeCount: counts.inMouse, sidearmCount: counts.sidearmOnly, blocker: "keySignalsMode" };
  }
  if (hasProfileHs2Trigger) {
    return { willActivate: false, nativeCount: 0, sidearmCount: counts.sidearmOnly, blocker: "hs2Trigger" };
  }
  if (counts.inMouse === 0) {
    return { willActivate: false, nativeCount: 0, sidearmCount: counts.sidearmOnly, blocker: "noNativeKeys" };
  }
  return { willActivate: true, nativeCount: counts.inMouse, sidearmCount: counts.sidearmOnly };
}

/** Rust's firmware planner preview; the UI never derives these decisions. */
export interface OfflineControl {
  controlId: string;
  layer: OfflineLayer;
  kind: "own" | "inherited" | "preserved" | "silent" | "role" | "unavailable";
  actionId?: string;
  native?: string;
  role?: "hypershift" | "profileButton" | "nativeClick";
  editable: boolean;
  reason?: "actionType" | "gesture" | "key" | "mouseModifiers" | "noTrigger";
  liveActionType?: string;
}

export interface OfflinePreview {
  target: {
    state: "written" | "notWritten" | "followsWindow" | "unknown" | "pending";
    bank?: number;
    writtenProfileId?: string;
    banks?: { bank: number; profileId: string; hybrid?: boolean }[];
    /** V3: the bank the exit selects, so the mouse plays it after Sidearm closes. */
    playingBank?: number;
    /** V3: effective hybrid hardware-bank mode for this profile (authoritative from backend). */
    hybrid?: boolean;
  };
  controls: OfflineControl[];
}

const KEY_CONTROL = /^(thumb_(0[1-9]|1[0-2])|top_aux_0[12])$/;

/** Whether `controlId` is one of the built-in Naga's key buttons (thumbs, top buttons). */
export function isKeyButton(controlId: string): boolean {
  return KEY_CONTROL.test(controlId);
}

/**
 * Whether a control belongs to the built-in Naga. Sidearm writes that device's
 * signals into the mouse itself, so they are an internal transport detail the
 * UI neither shows nor lets the user edit; user devices are identified by the
 * signal the user recorded and keep it visible.
 */
export function isBuiltinControl(config: AppConfig, controlId: ControlId | string): boolean {
  const control = config.physicalControls.find((entry) => entry.id === controlId);
  if (!control) return false;
  return config.devices.some((device) => device.id === control.deviceId && device.builtin === true);
}

/** Live mouse settings; the mouse stores them, so they are not in the config. */
export interface MouseSettings {
  batteryPercent: number | null;
  dpi: number | null;
  pollRateHz: number | null;
  status: "complete" | "partial" | "unavailable" | "disconnected";
  warnings: { field: "device" | "batteryPercent" | "dpi" | "pollRateHz"; message: import("./ui-text").UiText; details: string }[];
}

/** Battery reading from the guard (`mouse_battery`). */
export interface MouseBatteryEvent {
  /** Model name of the mouse read. */
  model: string;
  percent: number;
  low: boolean;
}

/** Onboard banks of a mouse (Rust `live_overlay::Banks`). */
export interface OnboardBanks {
  /** Banks holding a profile, ascending (1–5). */
  assigned: number[];
  /** The bank the mouse plays now. */
  active: number;
}

/** The natively driven model's limits (Rust `NativeModelInfo`, from the device catalog). */
export interface NativeModelInfo {
  name: string;
  /** Config device its controls belong to. */
  deviceId: string;
  dpiMin: number;
  dpiMax: number;
  /** Supported poll rates in Hz, ascending. */
  pollRates: number[];
  /** Proven on hardware; an unverified model's buttons are never written. */
  verified: boolean;
  /** The model is plugged in now (else it is the config's model). */
  connected: boolean;
  /** The mouse stores profiles in onboard banks (slots). */
  banks: boolean;
  /** `null`: the model has no consumer path; else whether its key buttons send
   *  consumer signals (read by Sidearm) rather than `F13`..`F24`. */
  consumerSignals: boolean | null;
}

/** Mouse-path states (shown in the Mouse tab) and one-time notices (toasts). */
export type MouseStatusKind =
  | "helperLost"
  | "buttonsUnreadable"
  | "mouseUnreachable"
  | "watchdogOff"
  | "mouseOffline"
  | "noFreeBankSlot"
  | "offlineNotStored";

/** Rust `mouse_status::StatusEvent` (`mouse_status` event, `get_mouse_status`). */
export interface MouseStatusEvent {
  kind: MouseStatusKind;
  active: boolean;
  /** The mouse a notice is about (`short_name`), when it names one. */
  model?: string;
}

/** Kinds shown once as a toast; the rest are states held until cleared. */
export const MOUSE_STATUS_NOTICES: readonly MouseStatusKind[] = ["offlineNotStored", "noFreeBankSlot"];

/** The guard detected driver mode or the Razer engine starting. */
export interface OnboardTakeoverEvent {
  /** `razerStarted`: Razer's engine came up and will fight for the mouse. */
  kind: "mode" | "razerStarted";
  /** `false` when the guard could not take the mouse back — Razer held on. */
  restored: boolean;
  controls: string[];
}
