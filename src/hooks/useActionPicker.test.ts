import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import type { AppConfig, Binding, ControlId } from "../lib/config";
import { makeConfig } from "../lib/test-fixtures";
import { useActionPicker } from "./useActionPicker";

afterEach(cleanup);

function makeDeps(config: AppConfig = makeConfig()) {
  return {
    effectiveProfileId: "p1" as string | null,
    config,
    selectedLayer: "standard" as const,
    offlinePreview: null,
    setSelectedControlId: vi.fn(),
    setActionPickerBindingId: vi.fn(),
    setActionPickerOpen: vi.fn(),
  };
}

describe("useActionPicker", () => {
  it.each([false, true])("honors offline editability %s and selects at opening priority", (editable) => {
    const deps = { ...makeDeps(), selectedLayer: "offline" as const,
      offlinePreview: { target: { state: "written" as const }, controls: [{ controlId: "thumb_01", layer: "offline" as const, kind: "role" as const, editable }] } };
    const { result } = renderHook(() => useActionPicker(deps));
    result.current("thumb_01", null);
    expect(deps.setActionPickerOpen).toHaveBeenCalledTimes(editable ? 1 : 0);
    if (editable) expect(deps.setSelectedControlId.mock.invocationCallOrder[0]).toBeLessThan(deps.setActionPickerOpen.mock.invocationCallOrder[0]);
  });
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
    expect(deps.setSelectedControlId).toHaveBeenCalledWith("thumb_01");
    expect(deps.setSelectedControlId.mock.invocationCallOrder[0]).toBeLessThan(deps.setActionPickerOpen.mock.invocationCallOrder[0]);
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
