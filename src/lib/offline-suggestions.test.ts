import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { makeConfig } from "./test-fixtures";
import { applyAllOfflineSuggestions, applyOfflineSuggestion, buildOfflineFixPlan } from "./offline-suggestions";
import type { OfflinePreview } from "./onboard-mapping";
import { findBinding } from "./config-editing";

const t = i18n.t.bind(i18n);

describe("offline-suggestions", () => {
  it("suggests EN and RU layout keys for a single '?' text snippet, including V2 native fallback", () => {
    const config = makeConfig({
      physicalControls: [
        ...makeConfig().physicalControls,
        { id: "mouse_4", deviceId: "razer-naga", family: "topPanel", defaultName: "Back", remappable: true, capabilityStatus: "verified" },
      ],
      actions: [
        { id: "a_q", type: "textSnippet", displayName: "?", payload: { source: "inline", text: "?", pasteMode: "sendText", tags: [] } },
      ],
      bindings: [
        { id: "b_q", profileId: "p1", layer: "hypershift", controlId: "mouse_4", actionId: "a_q", label: "?", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        // V2 native fallback: planner reverted mouse_4 to native mouseBack with no actionId
        { controlId: "mouse_4", layer: "offlineHypershift", kind: "inherited", native: "mouseBack", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p1", "razer-naga", preview, t);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].status).toBe("nativeFallback");
    expect(plan.items[0].suggestions.map((s) => s.payload)).toEqual([
      { key: "/", ctrl: false, shift: true, alt: false, win: false },
      { key: "7", ctrl: false, shift: true, alt: false, win: false },
    ]);
    expect(plan.items[0].suggestions[0].hint).toBeTruthy();
  });

  it("suggests hyphen for en-dash/em-dash and plain clicks for modifier-bearing mouse actions", () => {
    const config = makeConfig({
      physicalControls: [
        ...makeConfig().physicalControls,
        { id: "wheel_click", deviceId: "razer-naga", family: "wheel", defaultName: "Middle click", remappable: true, capabilityStatus: "verified" },
        { id: "mouse_4", deviceId: "razer-naga", family: "topPanel", defaultName: "Back", remappable: true, capabilityStatus: "verified" },
      ],
      actions: [
        { id: "a_dash", type: "textSnippet", displayName: "–", payload: { source: "inline", text: "–", pasteMode: "sendText", tags: [] } },
        { id: "a_ctrl_click", type: "mouseAction", displayName: "Ctrl+Click", payload: { action: "leftClick", ctrl: true } },
        { id: "a_hscroll", type: "mouseAction", displayName: "Scroll Left", payload: { action: "scrollLeft" } },
      ],
      bindings: [
        { id: "b1", profileId: "p1", layer: "hypershift", controlId: "thumb_01", actionId: "a_dash", label: "–", enabled: true },
        { id: "b2", profileId: "p1", layer: "standard", controlId: "wheel_click", actionId: "a_ctrl_click", label: "Ctrl+Click", enabled: true },
        { id: "b3", profileId: "p1", layer: "hypershift", controlId: "mouse_4", actionId: "a_hscroll", label: "Scroll Left", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offlineHypershift", kind: "silent", actionId: "a_dash", reason: "actionType", editable: true },
        { controlId: "wheel_click", layer: "offline", kind: "silent", actionId: "a_ctrl_click", reason: "mouseModifiers", editable: true },
        { controlId: "mouse_4", layer: "offlineHypershift", kind: "silent", actionId: "a_hscroll", reason: "mouseModifiers", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p1", "razer-naga", preview, t);
    expect(plan.items).toHaveLength(3);
    expect(plan.items[0].suggestions[0].payload).toEqual({ key: "-", ctrl: false, shift: false, alt: false, win: false });
    expect(plan.items[1].suggestions.map((s) => s.payload)).toEqual([
      { action: "middleClick" },
      { action: "leftClick" },
    ]);
    expect(plan.items[2].suggestions.map((s) => s.payload)).toEqual([
      { action: "mouseBack" },
      { key: "Left", ctrl: false, shift: false, alt: false, win: false },
    ]);
  });

  it("suggests fallback profile (Main) playable shortcut, hold promotion, and standard fallback, then applies all", () => {
    const config = makeConfig({
      actions: [
        { id: "a_main_hs", type: "shortcut", displayName: "Ctrl+L", payload: { key: "L", ctrl: true, shift: false, alt: false, win: false } },
        { id: "a_std", type: "shortcut", displayName: "Delete", payload: { key: "Delete", ctrl: false, shift: false, alt: false, win: false } },
        { id: "a_hold", type: "shortcut", displayName: "Ctrl+V", payload: { key: "V", ctrl: true, shift: false, alt: false, win: false } },
        { id: "a_phrase", type: "textSnippet", displayName: "Ask Me", payload: { source: "inline", text: "Ask me one question", pasteMode: "sendText", tags: [] } },
      ],
      bindings: [
        // Fallback profile p1 has Ctrl+L on thumb_01 hypershift
        { id: "b_main", profileId: "p1", layer: "hypershift", controlId: "thumb_01", actionId: "a_main_hs", label: "Ctrl+L", enabled: true },
        // Child profile p2 has text phrase on thumb_01 hypershift, Delete on standard, Ctrl+V on longPress
        { id: "b_p2_std", profileId: "p2", layer: "standard", controlId: "thumb_01", actionId: "a_std", label: "Delete", enabled: true },
        { id: "b_p2_hold", profileId: "p2", layer: "standard", controlId: "thumb_01", actionId: "a_hold", label: "Ctrl+V", enabled: true, triggerMode: "longPress" },
        { id: "b_p2_hs", profileId: "p2", layer: "hypershift", controlId: "thumb_01", actionId: "a_phrase", label: "Ask Me", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offlineHypershift", kind: "silent", actionId: "a_phrase", reason: "actionType", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p2", "razer-naga", preview, t);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].suggestions.map((s) => s.payload)).toEqual([
      { key: "L", ctrl: true, shift: false, alt: false, win: false },
      { key: "V", ctrl: true, shift: false, alt: false, win: false },
      { key: "Delete", ctrl: false, shift: false, alt: false, win: false },
    ]);

    const { config: updated, applied } = applyAllOfflineSuggestions(config, "p2", plan.items);
    expect(applied).toBe(1);
    const written = findBinding(updated, "p2", "offlineHypershift", "thumb_01");
    expect(written).toBeTruthy();
    expect(updated.actions.find((a) => a.id === written?.actionId)?.payload).toEqual({
      key: "L", ctrl: true, shift: false, alt: false, win: false,
    });
    // Live binding stays completely intact
    expect(findBinding(updated, "p2", "hypershift", "thumb_01")?.actionId).toBe("a_phrase");

    const single = applyOfflineSuggestion(config, "p2", "thumb_01", "offlineHypershift", plan.items[0].suggestions[1].payload);
    const writtenSingle = findBinding(single, "p2", "offlineHypershift", "thumb_01");
    expect(single.actions.find((a) => a.id === writtenSingle?.actionId)?.payload).toEqual({
      key: "V", ctrl: true, shift: false, alt: false, win: false,
    });
  });

  it("ignores own offline assignments and explicitly disabled live bindings", () => {
    const config = makeConfig({
      actions: [
        { id: "a_dis", type: "disabled", displayName: "Off", payload: {} },
      ],
      bindings: [
        { id: "b_dis", profileId: "p1", layer: "standard", controlId: "thumb_01", actionId: "a_dis", label: "Off", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offline", kind: "silent", actionId: "a_dis", editable: true },
        { controlId: "mouse_right", layer: "offline", kind: "own", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p1", "razer-naga", preview, t);
    expect(plan.items).toHaveLength(0);
    expect(plan.ownCount).toBe(1);
  });

  it("preserves explicit offline mutes, marks layout/pressEnter choices non-autoApply, and follows Rust HyperShift Standard fallback", () => {
    const config = makeConfig({
      actions: [
        { id: "a_q_enter", type: "textSnippet", displayName: "? + Enter", payload: { source: "inline", text: "?", pasteMode: "sendText", tags: [], pressEnter: true } },
        { id: "a_mute", type: "disabled", displayName: "Silent", payload: {} },
        { id: "a_std_q", type: "textSnippet", displayName: "?", payload: { source: "inline", text: "?", pasteMode: "sendText", tags: [] } },
        { id: "a_hs_dbl", type: "shortcut", displayName: "Ctrl+D", payload: { key: "D", ctrl: true, shift: false, alt: false, win: false } },
      ],
      bindings: [
        // Explicit offline mute on thumb_01 must never be overwritten even when live action is a '?' snippet
        { id: "b_live_1", profileId: "p1", layer: "standard", controlId: "thumb_01", actionId: "a_q_enter", label: "?", enabled: true },
        { id: "b_off_mute", profileId: "p1", layer: "offline", controlId: "thumb_01", actionId: "a_mute", label: "Silent", enabled: true },
        // Standard '?' + HyperShift doublePress: HyperShift offline inherits Standard '?' (matching Rust), not the doublePress
        { id: "b_std_2", profileId: "p1", layer: "standard", controlId: "mouse_right", actionId: "a_std_q", label: "?", enabled: true },
        { id: "b_hs_dbl_2", profileId: "p1", layer: "hypershift", controlId: "mouse_right", actionId: "a_hs_dbl", label: "Ctrl+D", enabled: true, triggerMode: "doublePress" },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offline", kind: "silent", actionId: "a_mute", editable: true },
        { controlId: "mouse_right", layer: "offlineHypershift", kind: "silent", actionId: "a_std_q", reason: "actionType", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p1", "razer-naga", preview, t);
    expect(plan.ownCount).toBe(1);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].controlId).toBe("mouse_right");
    expect(plan.items[0].suggestions.map((s) => s.autoApply)).toEqual([false, false]);
    expect(applyAllOfflineSuggestions(config, "p1", plan.items).applied).toBe(0);
  });
});
