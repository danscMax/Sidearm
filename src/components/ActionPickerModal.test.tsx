import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionPickerModal } from "./ActionPickerModal";
import { makeConfig } from "../lib/test-fixtures";
import type { AppConfig } from "../lib/config";
import { ensurePlaceholderBinding, makeActionId, makeBindingId } from "../lib/config-editing";

vi.mock("../lib/backend", () => ({
  getNativeModel: vi.fn().mockResolvedValue({ consumerSignals: false }),
  listNativeMice: vi.fn().mockResolvedValue([]),
  liveTestAction: vi.fn(), listenEncodedKeyEvent: vi.fn(), normalizeCommandError: vi.fn(),
  getMenuUsage: vi.fn().mockResolvedValue({}),
}));
afterEach(cleanup);

function show(controlId = "mouse_4", config = makeConfig(), bindingId: string | null = null) {
  const onSave = vi.fn<(config: AppConfig) => void>();
  const onCancel = vi.fn();
  render(<ActionPickerModal config={config} bindingId={bindingId} profileId="p1"
    controlId={controlId} selectedLayer="standard" onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}
function save() { fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); }

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
    expect(screen.getByText(/стоит и на других кнопках \(1\)/)).toBeTruthy();
    save();
    expect(second.onSave.mock.calls[0]![0].bindings.find((b) => b.id === "m1")!.actionId).toBe("menu");
  });

  it("does not offer unsupported encoded buttons as modifier triggers", () => {
    show("thumb_01");
    fireEvent.click(screen.getByRole("button", { name: /Клавиатура/ }));
    expect(screen.queryByRole("button", { name: /HyperShift · удержание/ })).toBeNull();
    expect(screen.queryByText(/удержание которой Sidearm умеет считывать/)).toBeNull();
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
