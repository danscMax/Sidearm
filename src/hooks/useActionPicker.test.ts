import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import { makeBindingId } from "../lib/config-editing";
import { useActionPicker } from "./useActionPicker";

function makeDeps() {
  return {
    effectiveProfileId: "p1" as string | null,
    selectedLayer: "standard" as Layer,
    updateDraft: vi.fn(),
    setActionPickerBindingId: vi.fn(),
    setActionPickerOpen: vi.fn(),
  };
}

describe("useActionPicker", () => {
  it("does nothing when there is no active profile", () => {
    const deps = { ...makeDeps(), effectiveProfileId: null };
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, null);

    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.setActionPickerOpen).not.toHaveBeenCalled();
    expect(deps.setActionPickerBindingId).not.toHaveBeenCalled();
  });

  it("opens the picker for an existing binding without mutating config", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, { id: "b-123" } as Binding);

    expect(deps.setActionPickerBindingId).toHaveBeenCalledWith("b-123");
    expect(deps.setActionPickerOpen).toHaveBeenCalledWith(true);
    expect(deps.updateDraft).not.toHaveBeenCalled();
  });

  it("creates a placeholder binding and opens the picker when none exists", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, null);

    expect(deps.updateDraft).toHaveBeenCalledTimes(1);
    const expectedId = makeBindingId("p1", "standard", "thumb_01" as ControlId);
    expect(deps.setActionPickerBindingId).toHaveBeenCalledWith(expectedId);
    expect(deps.setActionPickerOpen).toHaveBeenCalledWith(true);
  });

  it("leaves config unchanged if the control is not found", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("missing_control" as ControlId, null);

    const updater = deps.updateDraft.mock.calls[0]![0] as (c: AppConfig) => AppConfig;
    const cfg = { physicalControls: [] } as unknown as AppConfig;
    expect(updater(cfg)).toBe(cfg);
  });
});
