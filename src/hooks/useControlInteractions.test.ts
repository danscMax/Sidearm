import type React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import type { Action, Binding, ControlId, PhysicalControl } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { buildBindingDragData, HEAT_TINT } from "../lib/mouse-visual";
import {
  useControlInteractions,
  type UseControlInteractionsParams,
} from "./useControlInteractions";

const ASSIGNED: ControlId = "thumb_01";
const UNASSIGNED: ControlId = "thumb_02";

function assignedEntry(): ControlSurfaceEntry {
  return {
    control: { id: ASSIGNED, defaultName: "Thumb 1" } as unknown as PhysicalControl,
    binding: { id: "b1", enabled: true } as unknown as Binding,
    action: { id: "a1", type: "shortcut", displayName: "Ctrl+C" } as unknown as Action,
    mapping: null,
    isSelected: false,
  };
}

function unassignedEntry(): ControlSurfaceEntry {
  return {
    control: { id: UNASSIGNED, defaultName: "Thumb 2" } as unknown as PhysicalControl,
    binding: null,
    action: null,
    mapping: null,
    isSelected: false,
  };
}

function makeParams(
  overrides: Partial<UseControlInteractionsParams> = {},
): UseControlInteractionsParams {
  return {
    entries: [assignedEntry(), unassignedEntry()],
    onSelectControl: vi.fn(),
    onToggleMultiSelect: vi.fn(),
    onOpenActionPicker: vi.fn(),
    onContextMenu: vi.fn(),
    onDropBinding: vi.fn(),
    ...overrides,
  };
}

function makeMouse(extra: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    ctrlKey: false,
    metaKey: false,
    clientX: 10,
    clientY: 20,
    ...extra,
  } as unknown as React.MouseEvent<Element>;
  return { event, preventDefault };
}

function makeDrag(data?: string) {
  const setData = vi.fn();
  const getData = vi.fn(() => data ?? "");
  const preventDefault = vi.fn();
  const dataTransfer = { setData, getData, effectAllowed: "", dropEffect: "" };
  const event = { preventDefault, dataTransfer } as unknown as React.DragEvent<Element>;
  return { event, dataTransfer, setData, getData, preventDefault };
}

describe("useControlInteractions — getInteractionProps", () => {
  it("onClick selects, and ctrl/meta toggles multi-select", () => {
    const params = makeParams();
    const { result } = renderHook(() => useControlInteractions(params));
    result.current.getInteractionProps(ASSIGNED).onClick(makeMouse().event);
    expect(params.onSelectControl).toHaveBeenCalledWith(ASSIGNED);
    result.current.getInteractionProps(ASSIGNED).onClick(makeMouse({ ctrlKey: true }).event);
    expect(params.onToggleMultiSelect).toHaveBeenCalledWith(ASSIGNED);
  });

  it("onDoubleClick opens the picker with the control's binding", () => {
    const params = makeParams();
    const { result } = renderHook(() => useControlInteractions(params));
    const m = makeMouse();
    result.current.getInteractionProps(ASSIGNED).onDoubleClick(m.event);
    expect(m.preventDefault).toHaveBeenCalled();
    expect(params.onOpenActionPicker).toHaveBeenCalledWith(
      ASSIGNED,
      expect.objectContaining({ id: "b1" }),
    );
  });

  it("fires the context menu by default and omits it when opted out", () => {
    const params = makeParams();
    const { result } = renderHook(() => useControlInteractions(params));
    const m = makeMouse();
    result.current.getInteractionProps(ASSIGNED).onContextMenu?.(m.event);
    expect(m.preventDefault).toHaveBeenCalled();
    expect(params.onContextMenu).toHaveBeenCalledWith(
      ASSIGNED,
      expect.objectContaining({ id: "b1" }),
      expect.objectContaining({ id: "a1" }),
      10,
      20,
    );
    expect(
      result.current.getInteractionProps(ASSIGNED, { contextMenu: false }).onContextMenu,
    ).toBeUndefined();
  });

  it("onDragStart serializes the binding for an assigned control, blocks an unassigned one", () => {
    const params = makeParams();
    const { result } = renderHook(() => useControlInteractions(params));

    const d1 = makeDrag();
    result.current.getInteractionProps(ASSIGNED).onDragStart(d1.event);
    expect(d1.setData).toHaveBeenCalledWith("application/json", buildBindingDragData("a1"));
    expect(d1.dataTransfer.effectAllowed).toBe("copy");

    const d2 = makeDrag();
    result.current.getInteractionProps(UNASSIGNED).onDragStart(d2.event);
    expect(d2.preventDefault).toHaveBeenCalled();
    expect(d2.setData).not.toHaveBeenCalled();
  });

  it("onDrop forwards a valid payload and ignores a malformed one", () => {
    const params = makeParams();
    const { result } = renderHook(() => useControlInteractions(params));

    act(() => {
      result.current.getInteractionProps(UNASSIGNED).onDrop(makeDrag(buildBindingDragData("a1")).event);
    });
    expect(params.onDropBinding).toHaveBeenCalledWith(UNASSIGNED, "a1");

    (params.onDropBinding as ReturnType<typeof vi.fn>).mockClear();
    act(() => {
      result.current.getInteractionProps(UNASSIGNED).onDrop(makeDrag("{garbage").event);
    });
    expect(params.onDropBinding).not.toHaveBeenCalled();
  });
});

describe("useControlInteractions — hover / drag-over state", () => {
  it("tracks hoveredId on enter/leave", () => {
    const { result } = renderHook(() => useControlInteractions(makeParams()));
    act(() => result.current.getInteractionProps(ASSIGNED).onMouseEnter());
    expect(result.current.hoveredId).toBe(ASSIGNED);
    act(() => result.current.getInteractionProps(ASSIGNED).onMouseLeave());
    expect(result.current.hoveredId).toBeNull();
  });

  it("tracks dragOverId on enter/leave", () => {
    const { result } = renderHook(() => useControlInteractions(makeParams()));
    act(() => result.current.getInteractionProps(ASSIGNED).onDragEnter(makeDrag().event));
    expect(result.current.dragOverId).toBe(ASSIGNED);
    act(() => result.current.getInteractionProps(ASSIGNED).onDragLeave());
    expect(result.current.dragOverId).toBeNull();
  });
});

describe("useControlInteractions — applyHeatBg", () => {
  function fakeEl() {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    const el = { style: { setProperty, removeProperty } } as unknown as HTMLElement;
    return { el, setProperty, removeProperty };
  }

  it("tints a hot control when the heatmap is enabled", () => {
    const params = makeParams({ heatmapEnabled: true, executionCounts: new Map([[ASSIGNED, 5]]) });
    const { result } = renderHook(() => useControlInteractions(params));
    const { el, setProperty } = fakeEl();
    result.current.applyHeatBg(el, ASSIGNED);
    expect(setProperty).toHaveBeenCalledWith("background-color", HEAT_TINT);
  });

  it("clears the tint when the heatmap is off (or the count is zero)", () => {
    const params = makeParams({ heatmapEnabled: false, executionCounts: new Map([[ASSIGNED, 5]]) });
    const { result } = renderHook(() => useControlInteractions(params));
    const { el, removeProperty } = fakeEl();
    result.current.applyHeatBg(el, ASSIGNED);
    expect(removeProperty).toHaveBeenCalledWith("background-color");
  });

  it("no-ops on a null element", () => {
    const { result } = renderHook(() =>
      useControlInteractions(makeParams({ heatmapEnabled: true })),
    );
    expect(() => result.current.applyHeatBg(null, ASSIGNED)).not.toThrow();
  });
});
