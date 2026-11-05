import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppConfig, Binding, ControlId } from "../lib/config";
import { makeConfig } from "../lib/test-fixtures";
import { useActionPicker } from "./useActionPicker";

function makeDeps(config: AppConfig = makeConfig()) {
  return {
    effectiveProfileId: "p1" as string | null,
    config,
    setActionPickerBindingId: vi.fn(),
    setActionPickerOpen: vi.fn(),
  };
}

describe("useActionPicker", () => {
  it("does nothing when there is no active profile", () => {
    const deps = { ...makeDeps(), effectiveProfileId: null };
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, null);

    expect(deps.setActionPickerOpen).not.toHaveBeenCalled();
    expect(deps.setActionPickerBindingId).not.toHaveBeenCalled();
  });

  it("opens the picker for an existing binding without mutating config", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, { id: "b-123" } as Binding);

    expect(deps.setActionPickerBindingId).toHaveBeenCalledWith("b-123");
    expect(deps.setActionPickerOpen).toHaveBeenCalledWith(true);
    expect(deps.config.bindings).toHaveLength(0);
  });

  it("opens an unassigned button without creating or saving a placeholder", () => {
    const deps = makeDeps();
    const before = structuredClone(deps.config);
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, null);

    expect(deps.config).toEqual(before);
    expect(deps.setActionPickerBindingId).toHaveBeenCalledWith(null);
    expect(deps.setActionPickerOpen).toHaveBeenCalledWith(true);
  });

  it("leaves config unchanged and does not open if the control is not found", () => {
    const deps = makeDeps(makeConfig({ physicalControls: [] }));
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("missing_control" as ControlId, null);

    expect(deps.setActionPickerBindingId).not.toHaveBeenCalled();
    expect(deps.setActionPickerOpen).not.toHaveBeenCalled();
  });
});
