import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import { makeBindingId } from "../lib/config-editing";
import { makeConfig } from "../lib/test-fixtures";
import { useActionPicker } from "./useActionPicker";

/** Build deps whose updateDraft runs the updater against `config`, mirroring the
 *  real synchronous draft mutation so the hook can read back the created id. */
function makeDeps(config: AppConfig = makeConfig()) {
  let current = config;
  return {
    effectiveProfileId: "p1" as string | null,
    selectedLayer: "standard" as Layer,
    updateDraft: vi.fn((updater: (c: AppConfig) => AppConfig) => {
      current = updater(current);
    }),
    setActionPickerBindingId: vi.fn(),
    setActionPickerOpen: vi.fn(),
    get config() {
      return current;
    },
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

  // Audit F010: when the deterministic base binding id is already taken, the
  // placeholder gets a "-N" suffix. The picker must open on the actually-created
  // id, not the reconstructed base id.
  it("opens the picker on the real (suffixed) id when the base id is taken", () => {
    const baseId = makeBindingId("p1", "standard", "thumb_01" as ControlId);
    // Pre-seed a binding that already owns the base id but for a DIFFERENT slot,
    // so ensurePlaceholderBinding must mint a unique suffixed id for thumb_01.
    const seeded = makeConfig({
      bindings: [
        {
          id: baseId,
          profileId: "p1",
          layer: "standard",
          controlId: "mouse_4",
          label: "x",
          actionId: "a-existing",
          enabled: true,
        },
      ],
    });
    const deps = makeDeps(seeded);
    const { result } = renderHook(() => useActionPicker(deps));

    result.current("thumb_01" as ControlId, null);

    // It must NOT be the bare base id (that one is already taken).
    expect(deps.setActionPickerBindingId).not.toHaveBeenCalledWith(baseId);
    const openedId = deps.setActionPickerBindingId.mock.calls[0]![0] as string;
    expect(openedId.startsWith(baseId)).toBe(true);
    expect(openedId).not.toBe(baseId);
    // And that id must actually exist in the produced config.
    expect(deps.config.bindings.some((b) => b.id === openedId)).toBe(true);
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
