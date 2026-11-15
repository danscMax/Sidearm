import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ActionPickerModal } from "./ActionPickerModal";
import { makeConfig } from "../lib/test-fixtures";
import type { Action, AppConfig, OfflineLayer } from "../lib/config";
import * as editing from "../lib/config-editing";
import { mirrorMouseEdit, slotKey } from "../lib/device-transfer";
import { MOUSE_ACTION_OPTIONS } from "../lib/constants";
import { isOfflinePayloadPlayable } from "../lib/action-picker-helpers";
import { ensurePlaceholderBinding, findBinding, type Gesture, makeActionId, makeBindingId } from "../lib/config-editing";
import { NAGA_V3_DEVICE_ID } from "../lib/devices";
import * as backend from "../lib/backend";
import i18n from "../i18n";

vi.mock("../lib/backend", () => ({
  getNativeModel: vi.fn().mockResolvedValue({ consumerSignals: false }),
  listNativeMice: vi.fn().mockResolvedValue([]),
  liveTestAction: vi.fn().mockResolvedValue({ summary: "Test", warnings: [] }),
  listenEncodedKeyEvent: vi.fn(), normalizeCommandError: vi.fn((error) => ({ message: String(error) })),
  getMenuUsage: vi.fn().mockResolvedValue({}),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

function show(controlId = "mouse_4", config = makeConfig(), bindingId: string | null = null) {
  const onSave = vi.fn<(config: AppConfig) => void>();
  const onCancel = vi.fn();
  render(<ActionPickerModal config={config} bindingId={bindingId} profileId="p1"
    controlId={controlId} selectedLayer="standard" onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}
function save() { fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); }

describe("offline assignment picker", () => {
  it.each(["profile", "layer", "control"] as const)("remounts drafts and history when the %s identity changes", (identity) => {
    const first: Action = { id: "first", type: "shortcut", displayName: "First", payload: { key: "A", ctrl: true, shift: false, alt: false, win: false } };
    const second: Action = { ...first, id: "second", displayName: "Second", payload: { ...first.payload, key: "B" } };
    const config = makeConfig({ actions: [first, second] });
    const initial = { config, bindingId: null, profileId: "p1", selectedLayer: "offline" as const, controlId: "thumb_01", onSave: vi.fn(), onCancel: vi.fn(),
      offlineControl: { controlId: "thumb_01", layer: "offline" as const, kind: "inherited" as const, actionId: "first", editable: true } };
    const { rerender } = render(<ActionPickerModal {...initial} />);
    const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: i18n.t("picker.keyLabel") });
    expect(field().value).toBe("A");
    fireEvent.focus(field());
    fireEvent.keyDown(field(), { key: "Z", ctrlKey: true });
    fireEvent.blur(field());
    const next = { ...initial, profileId: identity === "profile" ? "p2" : "p1",
      selectedLayer: identity === "layer" ? "offlineHypershift" as const : "offline" as const,
      controlId: identity === "control" ? "thumb_02" : "thumb_01" };
    rerender(<ActionPickerModal {...next} offlineControl={{ ...initial.offlineControl, controlId: next.controlId, layer: next.selectedLayer, actionId: "second" }} />);
    expect(field().value).toBe("B");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("picker.undo") }).disabled).toBe(true);
  });

  it.each(["role", "unavailable"] as const)("refuses saving a %s but permits deleting an ineffective own assignment", (kind) => {
    const config = assigned("offline");
    const onSave = vi.fn();
    render(<ActionPickerModal config={config} bindingId="b" profileId="p1" controlId="thumb_01" selectedLayer="offline"
      offlineControl={{ controlId: "thumb_01", layer: "offline", kind, editable: false }} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("common.save") }).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.offlineInherit") }));
    save();
    expect(onSave.mock.calls[0][0].bindings).toEqual([]);
  });
  afterEach(() => vi.restoreAllMocks());
  const shortcut = { key: "C", ctrl: true, shift: false, alt: false, win: false };
  const action: Action = { id: "copy", type: "shortcut", displayName: "Copy", payload: shortcut };

  function assigned(layer: "standard" | "hypershift" | OfflineLayer, ownAction = action) {
    return makeConfig({ actions: [ownAction], bindings: [{ id: "b", profileId: "p1", controlId: "thumb_01",
      layer, actionId: ownAction.id, enabled: true, label: ownAction.displayName, triggerMode: "press" }] });
  }

  function showOffline(config = makeConfig(), layer: OfflineLayer = "offline", gesture: Gesture = "press") {
    const onSave = vi.fn<(config: AppConfig) => void>();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    const onGestureChange = vi.fn();
    render(<ActionPickerModal config={config} bindingId={null} profileId="p1" controlId="thumb_01"
      offlineControl={{ controlId: "thumb_01", layer, editable: true,
        kind: config.actions[0]?.type === "shortcut" || config.actions[0]?.type === "mouseAction"
          ? config.bindings[0]?.layer === layer ? "own" : "inherited" : "silent",
        actionId: config.actions[0]?.id }}
      selectedLayer={layer} gesture={gesture} onGestureChange={onGestureChange} onApply={onApply}
      onSave={onSave} onCancel={onCancel} />);
    return { onSave, onCancel, onApply, onGestureChange };
  }

  const category = (id: string) => screen.getByRole("button", { name: i18n.t(`action.type.${id}`) });
  function keys(key = "C", ctrlKey = true) {
    fireEvent.click(category("shortcut"));
    const field = screen.getByRole("textbox", { name: i18n.t("picker.keyLabel") });
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key, ctrlKey });
  }

  it.each(["offline", "offlineHypershift"] as const)("restricts %s to firmware actions and a plain press", (layer) => {
    showOffline(makeConfig(), layer, "longPress");
    const rail = screen.getByRole("navigation");
    expect(within(rail).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      expect.stringContaining(i18n.t("action.type.shortcut")), expect.stringContaining(i18n.t("action.type.mouseAction")),
      expect.stringContaining(i18n.t("picker.offlineSilent")), i18n.t("picker.offlineInherit"),
    ]);
    expect(screen.getByText(i18n.t("picker.offlineHint"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("picker.gestureHelp"))).toBeNull();
    for (const key of ["gestureLongPress", "gestureDoublePress", "gestureTriplePress", "test", "advancedTitle", "signalLabel", "nameLabel"]) {
      expect(screen.queryByText(i18n.t(`picker.${key}`))).toBeNull();
    }
    expect((screen.getByRole("button", { name: i18n.t("picker.offlineInherit") }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(category("mouseAction"));
    for (const option of MOUSE_ACTION_OPTIONS) {
      expect(screen.queryByRole("button", { name: i18n.t(option.label) }) !== null)
        .toBe(isOfflinePayloadPlayable({ action: option.value }));
    }
    expect(screen.queryByRole("checkbox", { name: "Ctrl" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("picker.searchPlaceholder") }), { target: { value: "dpiUp" } });
    expect(screen.queryByRole("button", { name: i18n.t("action.type.mouseAction") })).toBeNull();
  });

  it("blocks an unsupported recorded key and explains why, then allows a storable chord", () => {
    const { onSave } = showOffline();
    keys("AudioVolumeUp");
    expect(screen.getByText(i18n.t("picker.offlineUnstorable"))).toBeTruthy();
    expect((screen.getByRole("button", { name: i18n.t("common.save") }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    keys();
    expect(screen.queryByText(i18n.t("picker.offlineUnstorable"))).toBeNull();
    expect((screen.getByRole("button", { name: i18n.t("common.save") }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["offline", "offlineHypershift"] as const)("saves a shortcut via setOfflineAssignment on %s in one step", (layer) => {
    const config = makeConfig();
    const original = structuredClone(config);
    const write = vi.spyOn(editing, "setOfflineAssignment");
    const { onSave, onApply, onGestureChange } = showOffline(config, layer, "triplePress");
    keys();
    save();
    expect(write).toHaveBeenCalledExactlyOnceWith(config, "p1", "thumb_01", layer, shortcut);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(onGestureChange).not.toHaveBeenCalled();
    const result = onSave.mock.calls[0][0];
    expect(result.bindings).toEqual([expect.objectContaining({ layer, enabled: true, triggerMode: "press" })]);
    expect(result.actions[0]).toMatchObject({ type: "shortcut", payload: shortcut });
    expect(config).toEqual(original);
  });

  it("saves a firmware mouse action without modifiers", () => {
    const config = makeConfig();
    const write = vi.spyOn(editing, "setOfflineAssignment");
    const { onSave } = showOffline(config);
    fireEvent.click(category("mouseAction"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mouseAction.mouseBack") }));
    save();
    expect(write).toHaveBeenCalledExactlyOnceWith(config, "p1", "thumb_01", "offline",
      { action: "mouseBack", ctrl: false, shift: false, alt: false, win: false });
    expect(onSave.mock.calls[0][0].actions[0]).toMatchObject({ type: "mouseAction", payload: { action: "mouseBack" } });
  });

  it("saves Silent as an explicit override", () => {
    const config = assigned("standard");
    const write = vi.spyOn(editing, "setOfflineAssignment");
    const { onSave } = showOffline(config);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.offlineSilent") }));
    save();
    expect(write).toHaveBeenCalledExactlyOnceWith(config, "p1", "thumb_01", "offline", "silent");
    const result = onSave.mock.calls[0][0];
    const binding = findBinding(result, "p1", "offline", "thumb_01")!;
    expect(result.actions.find((action) => action.id === binding.actionId)?.type).toBe("disabled");
    expect(result.bindings.find((binding) => binding.layer === "standard")).toEqual(config.bindings[0]);
  });

  it.each(["offline", "offlineHypershift"] as const)("stages removing an own %s assignment until Save", (layer) => {
    const config = assigned(layer);
    const write = vi.spyOn(editing, "setOfflineAssignment");
    const { onSave, onCancel } = showOffline(config, layer);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.offlineInherit") }));
    expect(write).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.undo") }));
    expect(category("shortcut").getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.redo") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
    expect(screen.getByText(i18n.t("picker.discardTitle"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.keepEditing") }));
    save();
    expect(write).toHaveBeenCalledExactlyOnceWith(config, "p1", "thumb_01", layer, null);
    expect(onSave.mock.calls[0][0].bindings).toEqual([]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["offline", "offline"], ["offlineHypershift", "offlineHypershift"],
    ["standard", "offline"], ["hypershift", "offlineHypershift"], ["standard", "offlineHypershift"],
  ] as const)("prefills %s into %s, saving an own copy", (source, layer) => {
    const config = assigned(source);
    const { onSave } = showOffline(config, layer);
    expect(category("shortcut").getAttribute("aria-current")).toBe("true");
    expect((screen.getByRole("textbox", { name: i18n.t("picker.keyLabel") }) as HTMLInputElement).value).toBe("C");
    expect((screen.getByRole("checkbox", { name: "Ctrl" }) as HTMLInputElement).checked).toBe(true);
    save();
    const result = onSave.mock.calls[0][0];
    const binding = findBinding(result, "p1", layer, "thumb_01")!;
    expect(result.actions.find((action) => action.id === binding.actionId)).toMatchObject({ type: "shortcut", payload: shortcut });
    if (source !== layer) expect(result.bindings.find((binding) => binding.layer === source)).toEqual(config.bindings[0]);
  });

  it("prefills an inherited mouse action and starts silent for an unplayable live action", () => {
    const mouse: Action = { id: "mouse", type: "mouseAction", displayName: "Scroll", payload: { action: "scrollDown" } };
    const first = showOffline(assigned("standard", mouse));
    expect(category("mouseAction").getAttribute("aria-current")).toBe("true");
    save();
    expect(first.onSave.mock.calls[0][0].actions.at(-1)).toMatchObject({ type: "mouseAction", payload: { action: "scrollDown" } });
    cleanup();
    showOffline(assigned("standard", { id: "text", type: "textSnippet", displayName: "Text", payload: { source: "inline", text: "Hi", tags: [], pasteMode: "sendText" } }));
    expect(screen.getByRole("button", { name: i18n.t("picker.offlineSilent") }).getAttribute("aria-current")).toBe("true");
  });

  it("opens a silent override without changing config or saving on Cancel", () => {
    const config = assigned("offline", { id: "silent", type: "disabled", displayName: "Silent", payload: {} });
    const original = structuredClone(config);
    const { onSave, onCancel } = showOffline(config);
    expect(screen.getByRole("button", { name: i18n.t("picker.offlineSilent") }).getAttribute("aria-current")).toBe("true");
    expect((screen.getByRole("button", { name: i18n.t("picker.offlineInherit") }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(config).toEqual(original);
  });

  it.each(["offline", "offlineHypershift"] as const)("keeps %s slot sync through the existing persistence path", (layer) => {
    const config = assigned(layer);
    config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "Razer Naga V3 Pro", builtin: true });
    config.physicalControls.push({ ...config.physicalControls[1], id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID });
    const { onSave } = showOffline(config, layer);
    fireEvent.click(screen.getByRole("checkbox", { name: "Так же на Razer Naga V3 Pro" }));
    save();
    const next = mirrorMouseEdit(config, onSave.mock.calls[0][0]);
    expect(next.settings.syncSlots?.[slotKey("p1", layer, "press", "thumb_01")]).toBe(true);
    expect(findBinding(next, "p1", layer, "v3_thumb_01")).toMatchObject({ actionId: findBinding(next, "p1", layer, "thumb_01")!.actionId });
    cleanup();
    const removed = showOffline(next, layer);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.offlineInherit") }));
    save();
    const inherited = mirrorMouseEdit(next, removed.onSave.mock.calls[0][0]);
    expect(inherited.bindings).toEqual([]);
  });
});

describe("button role editor", () => {
  it("shows the configured global role instead of an unassigned action, without mutating config", () => {
    const config = makeConfig();
    config.settings.hypershiftTrigger = "mouse_4";
    const original = structuredClone(config);
    const { onSave, onCancel } = show("mouse_4", config);
    expect(screen.getByRole("button", { name: /HyperShift · удержание/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.queryByText(/Unassigned/)).toBeNull();
    expect(screen.getByText(/Для всех профилей/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Тест" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(config).toEqual(original);
  });

  it("moves the modifier in all profiles without adding bindings or dropping existing actions", () => {
    const config = makeConfig();
    const { onSave } = show("mouse_4", config);
    fireEvent.click(screen.getByRole("button", { name: /HyperShift · удержание/ }));
    expect(screen.getByText(/перенесён с кнопки «ПКМ»/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    save();
    expect(onSave.mock.calls[0]![0]).toEqual({ ...config, settings: { ...config.settings, hypershiftTrigger: "mouse_4", hypershiftTap: false } });
  });

  it("puts the modifier on the held press, keeping the quick press a click", () => {
    const config = makeConfig();
    const onSave = vi.fn<(config: AppConfig) => void>();
    render(<ActionPickerModal config={config} bindingId={null} profileId="p1" controlId="mouse_4" selectedLayer="standard"
      gesture="longPress" onGestureChange={vi.fn()} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /HyperShift · удержание/ }));
    save();
    expect(onSave.mock.calls[0]![0].settings).toMatchObject({ hypershiftTrigger: "mouse_4", hypershiftTap: true });
  });

  it("restores the native role and explicitly turns off the global modifier", () => {
    const config = makeConfig();
    config.settings.hypershiftTrigger = "mouse_4";
    const { onSave } = show("mouse_4", config);
    fireEvent.click(screen.getByRole("button", { name: /Исходное действие/ }));
    expect(screen.getByText(/выключит этот модификатор/)).toBeTruthy();
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.settings.hypershiftTrigger).toBe("none");
    expect(result.bindings).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it("creates one enabled real action on Save, preserving another action with a colliding derived id", () => {
    const config = makeConfig();
    const id = makeActionId("p1", "standard", "mouse_4");
    config.actions = [{ id, type: "textSnippet", displayName: "Keep", payload: { source: "inline", text: "Existing text", tags: [], pasteMode: "sendText" } }];
    config.bindings = [{ id: makeBindingId("p1", "standard", "mouse_4"), profileId: "p2", controlId: "thumb_01", layer: "standard", actionId: id, enabled: true, label: "Keep" }];
    const { onSave } = show("mouse_4", config);
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.actions).toHaveLength(2);
    expect(result.actions.find((a) => a.id === id)).toEqual(config.actions[0]);
    const binding = result.bindings.find((b) => b.profileId === "p1")!;
    expect(binding.id).not.toBe(config.bindings[0]!.id);
    expect(binding.enabled).toBe(true);
    expect(result.actions.find((a) => a.id === binding.actionId)?.type).toBe("disabled");
    expect(result.actions.some((a) => a.notes?.includes("placeholder"))).toBe(false);
  });

  it("ignores an old placeholder's disabled label and does not save on Escape", () => {
    const config = makeConfig();
    const seeded = ensurePlaceholderBinding(config, "p1", "standard", config.physicalControls[0]!);
    const { onSave, onCancel } = show("mouse_4", seeded.config, seeded.bindingId);
    expect(screen.getByRole("button", { name: /Исходное действие/ }).getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the existing assignment when the same button becomes the global modifier", () => {
    const config = makeConfig();
    config.actions = [{ id: "existing", type: "mouseAction", displayName: "Back", payload: { action: "mouseBack" } }];
    config.bindings = [{ id: "binding", profileId: "p1", controlId: "mouse_4", layer: "standard", actionId: "existing", enabled: true, label: "Back" }];
    const { onSave } = show("mouse_4", config, "binding");
    fireEvent.click(screen.getByRole("button", { name: /HyperShift · удержание/ }));
    save();
    expect(onSave.mock.calls[0]![0].bindings).toEqual(config.bindings);
    expect(onSave.mock.calls[0]![0].actions).toEqual(config.actions);
  });

  it("a real action replacing the modifier turns off HyperShift and creates no orphan placeholder", () => {
    const config = makeConfig();
    config.settings.hypershiftTrigger = "mouse_4";
    const { onSave } = show("mouse_4", config);
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.settings.hypershiftTrigger).toBe("none");
    expect(result.actions).toHaveLength(1);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.actionId).toBe(result.actions[0]!.id);
    expect(result.bindings[0]!.enabled).toBe(true);
  });

  it("edits an action another button shares for this button alone, but keeps a shared menu shared", () => {
    const config = makeConfig();
    config.actions = [
      { id: "back", type: "mouseAction", displayName: "Back", payload: { action: "mouseBack" } },
      { id: "menu", type: "menu", displayName: "Menu", payload: { items: [{ kind: "action", id: "i1", label: "Back", actionId: "back", enabled: true }] } },
    ];
    const bind = (id: string, controlId: string, actionId: string) =>
      ({ id, profileId: "p1", controlId, layer: "standard" as const, actionId, enabled: true, label: id });
    config.bindings = [bind("b1", "mouse_4", "back"), bind("b2", "mouse_5", "back"), bind("m1", "thumb_01", "menu"), bind("m2", "thumb_02", "menu")];

    const first = show("mouse_4", config, "b1");
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    save();
    const forked = first.onSave.mock.calls[0]![0];
    expect(forked.actions.find((a) => a.id === "back")).toEqual(config.actions[0]);
    expect(forked.bindings.find((b) => b.id === "b1")!.actionId).not.toBe("back");
    cleanup();

    const second = show("thumb_01", config, "m1");
    expect(screen.getByTitle(/стоит и на других кнопках \(1\)/).textContent).toMatch(/ещё 1 кнопка/);
    save();
    expect(second.onSave.mock.calls[0]![0].bindings.find((b) => b.id === "m1")!.actionId).toBe("menu");
  });

  it("does not offer unsupported encoded buttons as modifier triggers", () => {
    show("thumb_01");
    fireEvent.click(screen.getByRole("button", { name: /Клавиатура/ }));
    expect(screen.queryByRole("button", { name: /HyperShift · удержание/ })).toBeNull();
    expect(screen.queryByText(/удержание которой Sidearm умеет считывать/)).toBeNull();
  });

  it("forks a button's action when only a nested menu item also references it", () => {
    const config = makeConfig();
    config.actions = [
      { id: "back", type: "mouseAction", displayName: "Back", payload: { action: "mouseBack" } },
      { id: "menu", type: "menu", displayName: "Menu", payload: { items: [{ kind: "submenu", id: "sub", label: "Sub", enabled: true, items: [{ kind: "action", id: "item", label: "Back", actionId: "back", enabled: false }] }] } },
    ];
    config.bindings = [{ id: "binding", profileId: "p1", controlId: "mouse_4", layer: "standard", actionId: "back", enabled: true, label: "Back" }];
    const { onSave } = show("mouse_4", config, "binding");
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.actions.find((action) => action.id === "back")).toEqual(config.actions[0]);
    expect(result.actions.find((action) => action.id === "menu")).toEqual(config.actions[1]);
    expect(result.bindings[0].actionId).not.toBe("back");
    expect(result.actions.find((action) => action.id === result.bindings[0].actionId)?.type).toBe("disabled");
  });
});

describe("picker operation lifetime", () => {
  it("saves a 200-step sequence at the valid boundary", () => {
    const config = makeConfig();
    const steps = Array.from({ length: 200 }, () => ({ type: "send" as const, value: "A" }));
    config.actions = [{ id: "macro", type: "sequence", displayName: "Macro", payload: { steps } }];
    config.bindings = [{ id: "binding", profileId: "p1", controlId: "mouse_4", layer: "standard", actionId: "macro", enabled: true, label: "Macro" }];
    const { onSave } = show("mouse_4", config, "binding");
    const saveButton = screen.getByText(i18n.t("common.save"), { selector: "button" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].actions.find((action) => action.id === "macro")).toMatchObject({ type: "sequence", payload: { steps } });
  });

  it("cancels a pending Test countdown when the picker unmounts", async () => {
    vi.useFakeTimers();
    show();
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.test") }));
    cleanup();
    await act(() => vi.runAllTimersAsync());
    expect(backend.liveTestAction).not.toHaveBeenCalled();
  });

  it.each([0, 201])("keeps a %i-step sequence draft open instead of saving or testing it", (count) => {
    const config = makeConfig();
    config.actions = [{ id: "macro", type: "sequence", displayName: "Macro", payload: { steps: Array.from({ length: count }, () => ({ type: "send" as const, value: "A" })) } }];
    config.bindings = [{ id: "binding", profileId: "p1", controlId: "mouse_4", layer: "standard", actionId: "macro", enabled: true, label: "Macro" }];
    const { onSave } = show("mouse_4", config, "binding");
    expect((screen.getByText(i18n.t("common.save"), { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(i18n.t("picker.test"), { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(i18n.t(count === 0 ? "picker.sequenceEmpty" : "picker.sequenceStepLimit", { max: 200 }))).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("press pattern tabs", () => {
  it("keeps a tab's edit when switching to another tab, without closing", () => {
    const config = makeConfig();
    const onSave = vi.fn<(config: AppConfig) => void>();
    const onApply = vi.fn<(config: AppConfig) => void>();
    const onGestureChange = vi.fn();
    render(<ActionPickerModal config={config} bindingId={null} profileId="p1" controlId="thumb_01" selectedLayer="standard"
      gesture="longPress" onGestureChange={onGestureChange} onApply={onApply} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    fireEvent.click(screen.getByRole("button", { name: /Двойное/ }));
    expect(onGestureChange).toHaveBeenCalledWith("doublePress");
    expect(onSave).not.toHaveBeenCalled();
    const applied = onApply.mock.calls[0][0];
    const long = applied.bindings.find((b) => b.controlId === "thumb_01" && b.triggerMode === "longPress");
    expect(applied.actions.find((a) => a.id === long?.actionId)?.type).toBe("disabled");
  });
});

describe("a library text in the Text category", () => {
  function linkedConfig() {
    const config = makeConfig();
    config.snippetLibrary = [{ id: "lib1", name: "Sig", text: "Old", tags: [], pasteMode: "sendText" }];
    config.actions = [{ id: "act", type: "textSnippet", displayName: "Sig", payload: { source: "libraryRef", snippetId: "lib1" } }];
    config.bindings = [{ id: "b", profileId: "p1", controlId: "mouse_4", layer: "standard", actionId: "act", enabled: true, label: "Sig" }];
    return config;
  }
  const textBox = () => screen.getByRole("textbox", { name: i18n.t("picker.textLabel") });

  it("edits the library text for all its uses and stays linked", () => {
    const { onSave } = show("mouse_4", linkedConfig(), "b");
    expect(screen.getByText(i18n.t("snippet.linkedTitle", { name: "Sig" }))).toBeTruthy();
    expect(screen.getByText(new RegExp(i18n.t("snippet.usedInPlaces", { count: 1 })))).toBeTruthy();
    fireEvent.change(textBox(), { target: { value: "New {date}" } });
    expect(screen.getByText(i18n.t("snippet.linkedTitle", { name: "Sig" }))).toBeTruthy();
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.snippetLibrary).toEqual([{ id: "lib1", name: "Sig", text: "New {date}", tags: [], pasteMode: "sendText" }]);
    expect(result.actions.find((a) => a.id === "act")?.payload).toEqual({ source: "libraryRef", snippetId: "lib1" });
  });

  it("saves a blanked library text without blanking the library", () => {
    const { onSave } = show("mouse_4", linkedConfig(), "b");
    fireEvent.change(textBox(), { target: { value: "  " } });
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.snippetLibrary).toEqual(linkedConfig().snippetLibrary);
    expect(result.actions.find((a) => a.id === "act")?.payload).toEqual({ source: "libraryRef", snippetId: "lib1" });
  });

  it("detaches into the button's own copy only on request, leaving the library alone", () => {
    const { onSave } = show("mouse_4", linkedConfig(), "b");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("snippet.detach") }));
    fireEvent.change(textBox(), { target: { value: "Mine" } });
    save();
    const result = onSave.mock.calls[0]![0];
    expect(result.snippetLibrary).toEqual(linkedConfig().snippetLibrary);
    expect(result.actions.find((a) => a.id === "act")?.payload).toMatchObject({ source: "inline", text: "Mine" });
  });
});

describe("leaving with edits", () => {
  const picker = () => screen.getAllByRole("dialog")[0]!;
  const undo = () => fireEvent.keyDown(picker(), { key: "z", ctrlKey: true });

  it("asks before Cancel or Escape drop the edits: Keep editing stays, Discard closes", () => {
    const { onCancel } = show("thumb_01");
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Отбросить изменения?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить правку" }));
    expect(screen.queryByText("Отбросить изменения?")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Отбросить изменения?")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Отбросить изменения?")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Отбросить" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each<AppConfig["actions"][number]>([
    { id: "a", type: "shortcut", displayName: "Copy", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } },
    { id: "a", type: "textSnippet", displayName: "Hi", payload: { source: "libraryRef", snippetId: "s1" } },
    { id: "a", type: "sequence", displayName: "Macro", payload: { steps: [{ type: "send", value: "Ctrl+L" }, { type: "sleep", delayMs: 80 }] } },
    { id: "a", type: "menu", displayName: "Menu", payload: { items: [{ kind: "action", id: "i1", label: "Back", actionId: "back", enabled: true }] } },
  ])("closes an untouched $type at once", (action) => {
    const config = makeConfig();
    config.snippetLibrary = [{ id: "s1", name: "Hi", text: "Hello", tags: [], pasteMode: "sendText" }];
    config.actions = [action, { id: "back", type: "mouseAction", displayName: "Back", payload: { action: "mouseBack" } }];
    config.bindings = [{ id: "b", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: "a", enabled: true, label: "A" }];
    const { onCancel } = show("thumb_01", config, "b");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Отбросить изменения?")).toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes at once when nothing is left changed", () => {
    const { onCancel } = show("thumb_01");
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    undo();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Отбросить изменения?")).toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("undo across the press-pattern tabs", () => {
  /** The picker as App drives it: a tab switch applies the tab's edit and opens the other pattern. */
  function Tabs({ start, applied }: { start: AppConfig; applied: (config: AppConfig) => void }) {
    const [config, setConfig] = useState(start);
    const [gesture, setGesture] = useState<Gesture>("press");
    return <ActionPickerModal config={config} bindingId={findBinding(config, "p1", "standard", "thumb_01", gesture)?.id ?? null}
      profileId="p1" controlId="thumb_01" selectedLayer="standard" gesture={gesture} onGestureChange={setGesture}
      onApply={(next) => { setConfig(next); applied(next); }} onSave={vi.fn()} onCancel={vi.fn()} />;
  }
  const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
  const current = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-current");
  const dialog = () => screen.getAllByRole("dialog")[0]!;

  it("takes back the tab before's edit after a switch, and redoes it", () => {
    const start = makeConfig();
    const applied = vi.fn<(config: AppConfig) => void>();
    render(<Tabs start={start} applied={applied} />);
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    fireEvent.click(screen.getByRole("button", { name: /Двойное/ }));
    expect(applied.mock.lastCall![0].bindings).toHaveLength(1);
    expect(pressed(/Двойное/)).toBe("true");

    fireEvent.keyDown(dialog(), { key: "z", ctrlKey: true });
    expect(pressed(/Нажатие/)).toBe("true");
    expect(applied.mock.lastCall![0]).toBe(start);
    expect(current(/Отключено/)).toBe("true");
    fireEvent.keyDown(dialog(), { key: "z", ctrlKey: true });
    expect(current(/Исходное действие/)).toBe("true");

    fireEvent.keyDown(dialog(), { key: "y", ctrlKey: true });
    fireEvent.keyDown(dialog(), { key: "y", ctrlKey: true });
    expect(pressed(/Двойное/)).toBe("true");
    expect(applied.mock.lastCall![0].bindings).toHaveLength(1);
  });
});

describe("the same on the other mouse", () => {
  it("says what turning it on replaces on the other mouse", () => {
    const config = makeConfig();
    config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "Razer Naga V3 Pro", builtin: true });
    config.physicalControls.push({ ...config.physicalControls[1]!, id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID });
    config.actions = [{ id: "copy", type: "shortcut", displayName: "Copy", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } }];
    config.bindings = [{ id: "v3", profileId: "p1", controlId: "v3_thumb_01", layer: "standard", actionId: "copy", enabled: true, label: "Copy" }];
    show("thumb_01", config);
    fireEvent.click(screen.getByRole("button", { name: /Отключено/ }));
    const sync = screen.getByRole("checkbox", { name: "Так же на Razer Naga V3 Pro" });
    expect(screen.queryByText("На Razer Naga V3 Pro это заменит «Copy»")).toBeNull();
    fireEvent.click(sync);
    expect(screen.getByText("На Razer Naga V3 Pro это заменит «Copy»")).toBeTruthy();
    fireEvent.click(sync);
    expect(screen.queryByText("На Razer Naga V3 Pro это заменит «Copy»")).toBeNull();
  });
});
