import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOfflinePreview } from "../lib/backend";
import { makeConfig } from "../lib/test-fixtures";
import type { OfflinePreview } from "../lib/onboard-mapping";
import { useOfflinePreview } from "./useOfflinePreview";

vi.mock("../lib/backend", () => ({ getOfflinePreview: vi.fn() }));
const preview: OfflinePreview = { target: { state: "written" }, controls: [] };
const config = makeConfig();
beforeEach(() => { vi.useFakeTimers(); vi.mocked(getOfflinePreview).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = (ms = 150) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("debounces config/profile/device changes and sends the unsaved config", async () => {
  vi.mocked(getOfflinePreview).mockResolvedValue(preview);
  const { result, rerender } = renderHook(({ config, profile, device }) => useOfflinePreview(config, profile, device),
    { initialProps: { config: makeConfig(), profile: "p1", device: "razer-naga" } });
  await tick(149);
  expect(getOfflinePreview).not.toHaveBeenCalled();
  const config = makeConfig();
  rerender({ config, profile: "p2", device: "v3" });
  await tick(149);
  expect(result.current).toBeNull();
  await tick(1);
  expect(getOfflinePreview).toHaveBeenCalledExactlyOnceWith(config, "p2", "v3");
  expect(result.current).toEqual(preview);
  rerender({ config: { ...config }, profile: "p2", device: "v3" });
  expect(result.current).toBeNull();
});

it("drops stale responses during the next debounce and after unmount", async () => {
  let resolveOld!: (value: OfflinePreview) => void;
  let resolveNew!: (value: OfflinePreview) => void;
  vi.mocked(getOfflinePreview).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
  const { result, rerender, unmount } = renderHook(({ profile }) => useOfflinePreview(config, profile, "razer-naga"),
    { initialProps: { profile: "p1" } });
  await tick();
  rerender({ profile: "p2" });
  await act(async () => { resolveOld(preview); });
  expect(result.current).toBeNull();
  await tick();
  unmount();
  await act(async () => { resolveNew(preview); });
  expect(result.current).toBeNull();
});

it("returns unknown on failure and recovers on the next config", async () => {
  vi.mocked(getOfflinePreview).mockRejectedValueOnce(new Error("asleep")).mockResolvedValue(preview);
  const { result, rerender } = renderHook(({ value }) => useOfflinePreview(value, "p1", "razer-naga"),
    { initialProps: { value: config } });
  await tick();
  expect(result.current).toBeNull();
  rerender({ value: { ...config } });
  await tick();
  expect(result.current).toEqual(preview);
});

it("skips incomplete identities and cancels an unmounted debounce", async () => {
  const { unmount } = renderHook(() => useOfflinePreview(null, null, null));
  await tick();
  unmount();
  const pending = renderHook(() => useOfflinePreview(config, "p1", "razer-naga"));
  pending.unmount();
  await tick();
  expect(getOfflinePreview).not.toHaveBeenCalled();
});
