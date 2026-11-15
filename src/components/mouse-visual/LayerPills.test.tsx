import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { BINDING_DRAG_TYPE } from "../../lib/mouse-visual";
import { LayerPills } from "./LayerPills";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("offers Without Sidearm after all live layers and selects its standard sublayer", () => {
  const onSelect = vi.fn();
  render(<LayerPills selectedLayer="standard" onSelectLayer={onSelect} layers={["standard", "hypershift", "hypershift2", "hypershiftBoth"]} />);
  const pills = screen.getAllByRole("button");
  expect(pills.at(-1)?.textContent).toBe(i18n.t("offline.view"));
  fireEvent.click(pills.at(-1)!);
  expect(onSelect).toHaveBeenCalledWith("offline");
  expect(pills).toHaveLength(5);
});

it("keeps the offline pill selected while switching Standard and HyperShift", () => {
  const onSelect = vi.fn();
  const { rerender } = render(<LayerPills selectedLayer="offline" onSelectLayer={onSelect} />);
  expect(screen.getByRole("button", { name: i18n.t("offline.view"), pressed: true })).toBeTruthy();
  const sub = screen.getByRole("button", { name: i18n.t("offline.hypershift") });
  fireEvent.click(sub);
  expect(onSelect).toHaveBeenLastCalledWith("offlineHypershift");
  rerender(<LayerPills selectedLayer="offlineHypershift" onSelectLayer={onSelect} />);
  expect(screen.getByRole("button", { name: i18n.t("offline.view"), pressed: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: i18n.t("offline.hypershift"), pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("offline.standard") }));
  expect(onSelect).toHaveBeenLastCalledWith("offline");
});

it("does not offer offline layers for generic devices", () => {
  render(<LayerPills selectedLayer="standard" onSelectLayer={vi.fn()} neutralLabels />);
  expect(screen.queryByRole("button", { name: i18n.t("offline.view") })).toBeNull();
});

it("keeps drag-hover switching live-only and cancels pending switches on unmount", () => {
  vi.useFakeTimers();
  const onSelect = vi.fn();
  const { unmount } = render(<LayerPills selectedLayer="standard" onSelectLayer={onSelect} />);
  const drag = { dataTransfer: { types: [BINDING_DRAG_TYPE] } };
  const live = screen.getByRole("button", { name: i18n.t("layer.hypershift") });
  fireEvent.dragEnter(live, drag);
  act(() => vi.advanceTimersByTime(450));
  expect(onSelect).toHaveBeenLastCalledWith("hypershift");
  onSelect.mockClear();
  fireEvent.dragEnter(live, drag);
  fireEvent.dragEnter(screen.getByRole("button", { name: i18n.t("offline.view") }), drag);
  act(() => vi.advanceTimersByTime(450));
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.dragEnter(live, drag);
  unmount();
  act(() => vi.advanceTimersByTime(450));
  expect(onSelect).not.toHaveBeenCalled();
});

it("has no copy-layer context menu on the offline pill", () => {
  render(<LayerPills selectedLayer="offline" onSelectLayer={vi.fn()} onCopyLayer={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: i18n.t("offline.view") }));
  expect(screen.queryByRole("menu")).toBeNull();
});
