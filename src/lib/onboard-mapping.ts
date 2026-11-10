import type { AppConfig, ControlId } from "./config";

/**
 * One thumb binding the mouse can hold in its own memory. The backend owns the
 * vendor protocol (button id, HID usage, slot); the frontend only names the
 * control and the key it should emit.
 */
export interface OnboardBinding {
  controlId: ControlId;
  encodedKey: string;
}

/**
 * Which bindings the mouse confirmed it holds, and which it did not. The mouse
 * cannot be read, so a confirmation is a write the mouse echoed back.
 */
export interface OnboardReport {
  confirmed: OnboardBinding[];
  failed: ControlId[];
}

/**
 * Controls of the built-in Naga whose onboard record emits a key: `thumb_01`
 * through `thumb_12` and the two top buttons.
 */
const KEY_CONTROL = /^(thumb_(0[1-9]|1[0-2])|top_aux_0[12])$/;

/** Whether `controlId` is one of the built-in Naga's key buttons (thumbs, top buttons). */
export function isKeyButton(controlId: string): boolean {
  return KEY_CONTROL.test(controlId);
}

/**
 * Standard-layer key bindings (thumbs and top buttons) the mouse should emit on its own. Only the
 * standard layer reaches onboard memory: the mouse has no notion of Sidearm's
 * layers, so hypershift stays a software concern.
 */
export function onboardBindings(config: AppConfig): OnboardBinding[] {
  return config.encoderMappings
    .filter(
      (mapping) =>
        mapping.layer === "standard" && KEY_CONTROL.test(mapping.controlId),
    )
    .map((mapping) => ({
      controlId: mapping.controlId,
      encodedKey: mapping.encodedKey,
    }));
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
  | "offlineNotStored"
  | "signalsSwitched";

/** Rust `mouse_status::StatusEvent` (`mouse_status` event, `get_mouse_status`). */
export interface MouseStatusEvent {
  kind: MouseStatusKind;
  active: boolean;
}

/** Kinds shown once as a toast; the rest are states held until cleared. */
export const MOUSE_STATUS_NOTICES: readonly MouseStatusKind[] = ["offlineNotStored", "signalsSwitched"];

/**
 * What the backend's takeover guard had to take back from Razer's engine: the
 * device mode that made the firmware ignore onboard memory, or the onboard slots
 * themselves. The guard already put the device back; the event tells the UI so
 * the user learns why the buttons flickered and can force a re-apply.
 */
export interface OnboardTakeoverEvent {
  /** `razerStarted`: Razer's engine came up and will fight for the mouse. */
  kind: "mode" | "mappings" | "razerStarted";
  /** `false` when the guard could not take the mouse back — Razer held on. */
  restored: boolean;
  /** Controls whose stored mapping had been rewritten (mappings kind only). */
  controls: string[];
}
