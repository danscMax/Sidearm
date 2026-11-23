import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { makeConfig } from "./test-fixtures";
import {
  applyAllOfflineSuggestions,
  applyOfflineSuggestion,
  buildOfflineFixPlan,
  copyOfflineLayerFromFallback,
  resetAllOfflineOverrides,
} from "./offline-suggestions";
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
    // Standard fallback ("Delete") is suppressed when better suggestions (Main + hold) already exist.
    expect(plan.items[0].suggestions.map((s) => s.payload)).toEqual([
      { key: "L", ctrl: true, shift: false, alt: false, win: false },
      { key: "V", ctrl: true, shift: false, alt: false, win: false },
    ]);

    // When neither Main nor hold offers a replacement, Standard fallback IS still offered.
    const stdOnlyConfig = {
      ...config,
      bindings: config.bindings.filter((b) => b.id === "b_p2_std" || b.id === "b_p2_hs"),
    };
    const stdOnlyPlan = buildOfflineFixPlan(stdOnlyConfig, "p2", "razer-naga", preview, t);
    expect(stdOnlyPlan.items[0].suggestions.map((s) => s.payload)).toEqual([
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

  it("copies playable offline replacements from fallback profile and resets own overrides", () => {
    const config = makeConfig({
      actions: [
        { id: "a_main", type: "shortcut", displayName: "Ctrl+K", payload: { key: "K", ctrl: true, shift: false, alt: false, win: false } },
        { id: "a_phrase", type: "textSnippet", displayName: "Hello", payload: { source: "inline", text: "Hello world", pasteMode: "sendText", tags: [] } },
      ],
      bindings: [
        { id: "b_main", profileId: "p1", layer: "hypershift", controlId: "thumb_01", actionId: "a_main", label: "Ctrl+K", enabled: true },
        { id: "b_p2", profileId: "p2", layer: "hypershift", controlId: "thumb_01", actionId: "a_phrase", label: "Hello", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offlineHypershift", kind: "silent", actionId: "a_phrase", reason: "actionType", editable: true },
      ],
    };
    const plan = buildOfflineFixPlan(config, "p2", "razer-naga", preview, t);
    const { config: copiedCfg, copied } = copyOfflineLayerFromFallback(config, "p2", plan.items);
    expect(copied).toBe(1);
    expect(findBinding(copiedCfg, "p2", "offlineHypershift", "thumb_01")).toBeTruthy();

    const { config: resetCfg, removed } = resetAllOfflineOverrides(copiedCfg, "p2", "razer-naga");
    expect(removed).toBe(1);
    expect(findBinding(resetCfg, "p2", "offlineHypershift", "thumb_01")).toBeNull();

    // Disabled offline override in fallback profile falls through to live Standard layer on offlineHypershift.
    const disabledOfflineInMain = makeConfig({
      actions: [
        { id: "a_std", type: "shortcut", displayName: "Ctrl+S", payload: { key: "S", ctrl: true, shift: false, alt: false, win: false } },
        { id: "a_phrase", type: "textSnippet", displayName: "Hello", payload: { source: "inline", text: "Hello world", pasteMode: "sendText", tags: [] } },
      ],
      bindings: [
        { id: "b_main_off_dis", profileId: "p1", layer: "offlineHypershift", controlId: "thumb_01", actionId: "a_std", label: "Off", enabled: false },
        { id: "b_main_std", profileId: "p1", layer: "standard", controlId: "thumb_01", actionId: "a_std", label: "Ctrl+S", enabled: true },
        { id: "b_p2_hs", profileId: "p2", layer: "hypershift", controlId: "thumb_01", actionId: "a_phrase", label: "Hello", enabled: true },
      ],
    });
    const fallPlan = buildOfflineFixPlan(disabledOfflineInMain, "p2", "razer-naga", preview, t);
    const fallCopy = copyOfflineLayerFromFallback(disabledOfflineInMain, "p2", fallPlan.items);
    expect(fallCopy.copied).toBe(1);
    expect(findBinding(fallCopy.config, "p2", "offlineHypershift", "thumb_01")).toBeTruthy();
  });

  it("suggests Ctrl+= / Ctrl+- for Ctrl+scroll zoom, prefers arrow keys over duplicate Back/Forward, promotes HyperShift 2 & sequences, and never auto-applies Standard duplicates", () => {
    const config = makeConfig({
      physicalControls: [
        ...makeConfig().physicalControls,
        { id: "wheel_up", deviceId: "razer-naga", family: "wheel", defaultName: "Scroll Up", remappable: true, capabilityStatus: "verified" },
        { id: "wheel_down", deviceId: "razer-naga", family: "wheel", defaultName: "Scroll Down", remappable: true, capabilityStatus: "verified" },
        { id: "mouse_4", deviceId: "razer-naga", family: "topPanel", defaultName: "Back", remappable: true, capabilityStatus: "verified" },
        { id: "thumb_02", deviceId: "razer-naga", family: "thumbGrid", defaultName: "Thumb 2", remappable: true, capabilityStatus: "verified" },
        { id: "thumb_03", deviceId: "razer-naga", family: "thumbGrid", defaultName: "Thumb 3", remappable: true, capabilityStatus: "verified" },
      ],
      actions: [
        { id: "a_zoom_in", type: "mouseAction", displayName: "Zoom In", payload: { action: "scrollUp", ctrl: true } },
        { id: "a_zoom_out", type: "mouseAction", displayName: "Zoom Out", payload: { action: "scrollDown", ctrl: true } },
        { id: "a_back", type: "mouseAction", displayName: "Back", payload: { action: "mouseBack" } },
        { id: "a_hleft", type: "mouseAction", displayName: "Scroll Left", payload: { action: "scrollLeft" } },
        { id: "a_phrase", type: "textSnippet", displayName: "Phrase", payload: { source: "inline", text: "Long phrase", pasteMode: "sendText", tags: [] } },
        { id: "a_hs2_bold", type: "shortcut", displayName: "Ctrl+B", payload: { key: "B", ctrl: true, shift: false, alt: false, win: false } },
        { id: "a_std_del", type: "shortcut", displayName: "Delete", payload: { key: "Delete", ctrl: false, shift: false, alt: false, win: false } },
        { id: "a_seq_esc", type: "sequence", displayName: "Esc Esc", payload: { steps: [{ type: "send", value: "Esc" }, { type: "sleep", delayMs: 80 }, { type: "send", value: "Esc" }] } },
      ],
      bindings: [
        { id: "b_zi", profileId: "p1", layer: "hypershift", controlId: "wheel_up", actionId: "a_zoom_in", label: "Zoom In", enabled: true },
        { id: "b_zo", profileId: "p1", layer: "hypershift", controlId: "wheel_down", actionId: "a_zoom_out", label: "Zoom Out", enabled: true },
        { id: "b_m4_std", profileId: "p1", layer: "standard", controlId: "mouse_4", actionId: "a_back", label: "Back", enabled: true },
        { id: "b_m4_hs", profileId: "p1", layer: "hypershift", controlId: "mouse_4", actionId: "a_hleft", label: "Scroll Left", enabled: true },
        { id: "b_t1_std", profileId: "p1", layer: "standard", controlId: "thumb_01", actionId: "a_std_del", label: "Delete", enabled: true },
        { id: "b_t1_hs", profileId: "p1", layer: "hypershift", controlId: "thumb_01", actionId: "a_phrase", label: "Phrase", enabled: true },
        { id: "b_t1_hs2", profileId: "p1", layer: "hypershift2", controlId: "thumb_01", actionId: "a_hs2_bold", label: "Ctrl+B", enabled: true },
        { id: "b_t2_std", profileId: "p1", layer: "standard", controlId: "thumb_02", actionId: "a_std_del", label: "Delete", enabled: true },
        { id: "b_t2_hs", profileId: "p1", layer: "hypershift", controlId: "thumb_02", actionId: "a_phrase", label: "Phrase", enabled: true },
        { id: "b_t3_std", profileId: "p1", layer: "standard", controlId: "thumb_03", actionId: "a_seq_esc", label: "Esc Esc", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "wheel_up", layer: "offlineHypershift", kind: "silent", actionId: "a_zoom_in", reason: "mouseModifiers", editable: true },
        { controlId: "wheel_down", layer: "offlineHypershift", kind: "silent", actionId: "a_zoom_out", reason: "mouseModifiers", editable: true },
        { controlId: "mouse_4", layer: "offlineHypershift", kind: "silent", actionId: "a_hleft", reason: "mouseModifiers", editable: true },
        { controlId: "thumb_01", layer: "offlineHypershift", kind: "silent", actionId: "a_phrase", reason: "actionType", editable: true },
        { controlId: "thumb_02", layer: "offlineHypershift", kind: "silent", actionId: "a_phrase", reason: "actionType", editable: true },
        { controlId: "thumb_03", layer: "offline", kind: "silent", actionId: "a_seq_esc", reason: "actionType", editable: true },
      ],
    };

    const plan = buildOfflineFixPlan(config, "p1", "razer-naga", preview, t);
    const byKey = new Map(plan.items.map((item) => [`${item.layer}:${item.controlId}`, item]));

    // Ctrl+ScrollUp/Down -> Ctrl+= / Ctrl+- with autoApply=true
    expect(byKey.get("offlineHypershift:wheel_up")?.suggestions[0]).toMatchObject({
      payload: { key: "=", ctrl: true, shift: false, alt: false, win: false },
      autoApply: true,
    });
    expect(byKey.get("offlineHypershift:wheel_down")?.suggestions[0]).toMatchObject({
      payload: { key: "-", ctrl: true, shift: false, alt: false, win: false },
      autoApply: true,
    });

    // When Standard already does mouseBack on mouse_4, HyperShift scrollLeft suggests Left arrow FIRST
    expect(byKey.get("offlineHypershift:mouse_4")?.suggestions[0]).toMatchObject({
      payload: { key: "Left", ctrl: false, shift: false, alt: false, win: false },
      autoApply: true,
    });

    // HyperShift 2 shortcut (Ctrl+B) is promoted for silent offlineHypershift slot
    expect(byKey.get("offlineHypershift:thumb_01")?.suggestions[0]).toMatchObject({
      payload: { key: "B", ctrl: true, shift: false, alt: false, win: false },
      autoApply: true,
    });

    // Fallback to Standard ("Delete") on thumb_02 is shown for 1-click choice, but autoApply is false
    expect(byKey.get("offlineHypershift:thumb_02")?.suggestions[0]).toMatchObject({
      payload: { key: "Delete", ctrl: false, shift: false, alt: false, win: false },
      autoApply: false,
    });

    // Repeat-shortcut sequence (Esc -> sleep -> Esc) suggests Esc with autoApply=true
    expect(byKey.get("offline:thumb_03")?.suggestions[0]).toMatchObject({
      payload: { key: "Esc", ctrl: false, shift: false, alt: false, win: false },
      autoApply: true,
    });

    // applyAll applies 5 items (skipping thumb_02 Standard-duplicate)
    const { applied } = applyAllOfflineSuggestions(config, "p1", plan.items);
    expect(applied).toBe(5);
  });
});
