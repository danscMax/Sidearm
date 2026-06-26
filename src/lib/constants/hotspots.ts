import type { ControlId } from "../config";
import type { HotspotPosition } from "./types";

/** Hotspot positions for the TOP-DOWN photo (naga-top.webp).
 *  Measured via hotspot-test.html click calibration. */
export const topViewHotspots: Partial<Record<ControlId, HotspotPosition>> = {
  mouse_left:        { left: 25.5, top: 10, label: "control.name.mouseLeft" },
  wheel_up:          { left: 45.5, top: 13.5, label: "▲", size: "sm" },
  wheel_click:       { left: 45.5, top: 22, label: "●", size: "sm" },
  wheel_down:        { left: 45.5, top: 31, label: "▼", size: "sm" },
  hypershift_button: { left: 68, top: 10.5, label: "HS", size: "sm" },
  top_aux_01:        { left: 10, top: 10.5, label: "D+", size: "sm" },
  top_aux_02:        { left: 10, top: 21, label: "D−", size: "sm" },
  mouse_4:           { left: 31, top: 22.5, label: "←", size: "sm" },
  mouse_5:           { left: 60.5, top: 22.5, label: "→", size: "sm" },
};

/** Hotspot positions for the SIDE photo (naga-side.webp).
 *  Layout: 4 columns × 3 rows. Each column counts bottom-to-top (1→2→3).
 *  Columns go left-to-right (front-to-back of mouse). */
export const sideViewHotspots: Partial<Record<ControlId, HotspotPosition>> = {
  thumb_01: { left: 44.5, top: 76, label: "1" },
  thumb_02: { left: 42.5, top: 56.5, label: "2" },
  thumb_03: { left: 40.5, top: 35.5, label: "3" },
  thumb_04: { left: 52, top: 74, label: "4" },
  thumb_05: { left: 50, top: 54, label: "5" },
  thumb_06: { left: 48, top: 32, label: "6" },
  thumb_07: { left: 59, top: 71, label: "7" },
  thumb_08: { left: 57, top: 51.5, label: "8" },
  thumb_09: { left: 55.5, top: 29.5, label: "9" },
  thumb_10: { left: 66, top: 69.5, label: "10" },
  thumb_11: { left: 64, top: 50, label: "11" },
  thumb_12: { left: 62, top: 28, label: "12" },
};

/** Hotspot positions for the COMBINED 3/4-angle photo (naga-combined.webp).
 *  Shows all buttons: thumb grid + top panel on one image. */
export const combinedViewHotspots: Partial<Record<ControlId, HotspotPosition>> = {
  // Thumb grid
  thumb_01:          { left: 24.5, top: 44, label: "1", size: "sm" },
  thumb_02:          { left: 29, top: 42.5, label: "2", size: "sm" },
  thumb_03:          { left: 34, top: 40.5, label: "3", size: "sm" },
  thumb_04:          { left: 25, top: 50.5, label: "4", size: "sm" },
  thumb_05:          { left: 30, top: 49, label: "5", size: "sm" },
  thumb_06:          { left: 35.5, top: 47.5, label: "6", size: "sm" },
  thumb_07:          { left: 26, top: 57, label: "7", size: "sm" },
  thumb_08:          { left: 31, top: 55.5, label: "8", size: "sm" },
  thumb_09:          { left: 36.5, top: 54, label: "9", size: "sm" },
  thumb_10:          { left: 26.5, top: 64, label: "10", size: "sm" },
  thumb_11:          { left: 31.5, top: 62, label: "11", size: "sm" },
  thumb_12:          { left: 37, top: 60.5, label: "12", size: "sm" },
  // Top panel
  mouse_left:        { left: 41.5, top: 12, label: "control.name.mouseLeft", size: "sm" },
  top_aux_01:        { left: 33, top: 13, label: "D+", size: "sm" },
  top_aux_02:        { left: 35, top: 22.5, label: "D−", size: "sm" },
  wheel_up:          { left: 52, top: 15, label: "▲", size: "sm" },
  wheel_click:       { left: 56, top: 23.5, label: "●", size: "sm" },
  wheel_down:        { left: 56.5, top: 32.5, label: "▼", size: "sm" },
  hypershift_button: { left: 60.5, top: 14, label: "HS", size: "sm" },
  mouse_4:           { left: 50, top: 23.5, label: "←", size: "sm" },
  mouse_5:           { left: 61, top: 23.5, label: "→", size: "sm" },
};
