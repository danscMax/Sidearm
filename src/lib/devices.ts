import type { AppConfig, ControlId } from "./config";
import { RAZER_NAGA_DEVICE_ID } from "./config";
import {
  combinedViewHotspots,
  nagaV3CombinedHotspots,
  nagaV3TopHotspots,
  topViewHotspots,
} from "./constants/hotspots";
import type { HotspotPosition } from "./constants/types";
import type { ViewTab } from "./mouse-visual";

/**
 * How Sidearm draws and explains one built-in mouse. Everything that differs
 * between models in the UI lives here; components read the layout of the
 * device they show instead of testing for a model. The backend's matching
 * data is `src-tauri/src/device_catalog.rs` (`device_id`, `control_prefix`).
 */
export interface DeviceLayout {
  deviceId: string;
  /** Prefix of this device's control ids in the config (`v3_thumb_01`). */
  controlPrefix: string;
  /** Layout id of the button the firmware holds as HyperShift; absent = the
   *  software trigger from `settings.hypershiftTrigger`. */
  firmwareTrigger?: ControlId;
  /** Photo tabs in display order. */
  views: ViewTab[];
  /** Whether the schematic (SVG) view exists for this layout. */
  schematic: boolean;
  /** i18n keys of the view tabs, when they differ from the defaults. */
  tabLabels?: Partial<Record<ViewTab, string>>;
  top: ViewLayout;
  combined: ViewLayout;
  bottom?: ViewLayout;
  /** i18n key of a note under the side view. */
  sideNote?: string;
  /** Controls the setup wizard checks one by one after the thumb grid, by
   *  layout id, with their i18n name keys. */
  checkedExtras: readonly (readonly [ControlId, string])[];
}

interface ViewLayout {
  hotspots: Partial<Record<ControlId, HotspotPosition>>;
  left: ControlId[];
  right: ControlId[];
}

export const NAGA_V3_DEVICE_ID = "razer-naga-v3";

/* ── V2 legend columns, shared by the photo and schematic views ── */

export const TOP_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
];

export const TOP_RIGHT_BUTTONS: ControlId[] = [
  "mouse_right", "wheel_up", "wheel_click", "mouse_5", "wheel_down",
];

export const COMBINED_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
  "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
];

export const COMBINED_RIGHT_BUTTONS: ControlId[] = [
  "mouse_right", "wheel_up", "wheel_click", "wheel_down", "mouse_5",
  "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
];

const NAGA_V2_LAYOUT: DeviceLayout = {
  deviceId: RAZER_NAGA_DEVICE_ID,
  controlPrefix: "",
  views: ["combined", "top", "side"],
  schematic: true,
  top: { hotspots: topViewHotspots, left: TOP_LEFT_BUTTONS, right: TOP_RIGHT_BUTTONS },
  combined: { hotspots: combinedViewHotspots, left: COMBINED_LEFT_BUTTONS, right: COMBINED_RIGHT_BUTTONS },
  checkedExtras: [],
};

const V3_TOP_LEFT: ControlId[] = ["mouse_left", "top_aux_01", "top_aux_02", "wheel_left", "top_special_01"];
const V3_TOP_RIGHT: ControlId[] = [
  "mouse_right", "wheel_up", "wheel_click", "wheel_down", "wheel_right", "hypershift_button", "top_special_02",
];
const THUMBS_LEFT = COMBINED_LEFT_BUTTONS.filter((id) => id.startsWith("thumb_"));
const THUMBS_RIGHT = COMBINED_RIGHT_BUTTONS.filter((id) => id.startsWith("thumb_"));

const NAGA_V3_LAYOUT: DeviceLayout = {
  deviceId: NAGA_V3_DEVICE_ID,
  controlPrefix: "v3_",
  firmwareTrigger: "hypershift_button",
  views: ["combined", "top", "side", "bottom"],
  schematic: false,
  tabLabels: {
    combined: "visualization.v3All",
    top: "visualization.v3Top",
    side: "visualization.v3Side",
    bottom: "visualization.v3Bottom",
  },
  top: { hotspots: nagaV3TopHotspots, left: V3_TOP_LEFT, right: V3_TOP_RIGHT },
  combined: {
    hotspots: nagaV3CombinedHotspots,
    left: [...V3_TOP_LEFT, ...THUMBS_LEFT],
    right: [...V3_TOP_RIGHT, ...THUMBS_RIGHT],
  },
  bottom: { hotspots: { top_special_03: { left: 48.33, top: 64.29, label: "↓" } }, left: ["top_special_03"], right: [] },
  sideNote: "visualization.v3Plate12",
  checkedExtras: [
    ["top_aux_01", "control.name.dpiPlus"],
    ["top_aux_02", "control.name.dpiMinus"],
    ["wheel_left", "control.name.v3TiltLeft"],
    ["wheel_right", "control.name.v3TiltRight"],
    ["wheel_click", "control.name.wheelClick"],
    ["wheel_up", "control.name.wheelUp"],
    ["wheel_down", "control.name.wheelDown"],
    ["top_special_01", "control.name.v3ScrollMode"],
    ["top_special_02", "control.name.v3ScrollAux"],
    ["top_special_03", "control.name.v3ProfileButton"],
  ],
};

const LAYOUTS: readonly DeviceLayout[] = [NAGA_V2_LAYOUT, NAGA_V3_LAYOUT];

/** The V2 layout, for a view with no device selected yet. */
export function defaultLayout(): DeviceLayout {
  return NAGA_V2_LAYOUT;
}

/** The layout of a built-in device; `undefined` for a user-learned device. */
export function deviceLayout(deviceId: string | null | undefined): DeviceLayout | undefined {
  return LAYOUTS.find((layout) => layout.deviceId === deviceId);
}

/** The layout of the device a config control belongs to. */
export function controlLayout(config: AppConfig, controlId: ControlId): DeviceLayout | undefined {
  return deviceLayout(config.physicalControls.find((control) => control.id === controlId)?.deviceId);
}

/** The shared layout id of a control (`v3_thumb_01` → `thumb_01`). */
export function layoutControlId(controlId: ControlId): ControlId {
  const layout = LAYOUTS.find((entry) => entry.controlPrefix && controlId.startsWith(entry.controlPrefix));
  return layout ? controlId.slice(layout.controlPrefix.length) : controlId;
}

/** A device's config id of a layout control (`thumb_01` → `v3_thumb_01`). */
export function deviceControlId(layout: DeviceLayout, layoutId: ControlId): ControlId {
  return layout.controlPrefix + layoutId;
}

/** The control that holds HyperShift on a device: the firmware button, or
 *  the configured software trigger. */
export function hypershiftControlId(config: AppConfig, deviceId: string): ControlId | null {
  const layout = deviceLayout(deviceId);
  if (!layout) return null;
  if (layout.firmwareTrigger) return deviceControlId(layout, layout.firmwareTrigger);
  const trigger = config.settings.hypershiftTrigger ?? "mouse_right";
  return trigger === "none" ? null : deviceControlId(layout, trigger);
}

/** Whether a built-in device of this id is in the config. */
export function hasDevice(config: AppConfig, deviceId: string): boolean {
  return config.devices.some((device) => device.id === deviceId);
}
