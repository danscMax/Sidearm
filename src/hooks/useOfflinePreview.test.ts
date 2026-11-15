import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOfflinePreview, listenMouseStatus, listenMouseBattery, listenNativeMiceChanged } from "../lib/backend";
import { makeConfig } from "../lib/test-fixtures";
import type { MouseStatusEvent, OfflinePreview } from "../lib/onboard-mapping";
import { useOfflinePreview } from "./useOfflinePreview";

vi.mock("../lib/backend", () => ({
  getOfflinePreview: vi.fn(), listenMouseStatus: vi.fn(), listenMouseBattery: vi.fn(), listenNativeMiceChanged: vi.fn(),
}));
const preview: OfflinePreview = { target: { state: "written" }, controls: [] };
const config = makeConfig();
let mouseStatus: (event: MouseStatusEvent) => void;
let mouseBattery: () => void;
let nativeMiceChanged: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mouseStatus = () => {};
  mouseBattery = () => {};
  nativeMiceChanged = () => {};
  vi.mocked(listenMouseStatus).mockImplementation(async (callback) => { mouseStatus = callback; return vi.fn<() => void>(); });
  vi.mocked(listenMouseBattery).mockImplementation(async (callback) => {
    mouseBattery = () => callback({ model: "V3", percent: 63, low: false }); return vi.fn<() => void>();
  });
  vi.mocked(listenNativeMiceChanged).mockImplementation(async (callback) => { nativeMiceChanged = () => callback([]); return vi.fn<() => void>(); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = (ms = 150) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it.each(["mouse status", "battery", "native mice"])("recovers a failed preview and updates its playing bank on %s", async (event) => {
  vi.mocked(getOfflinePreview).mockRejectedValueOnce(new Error("asleep")).mockResolvedValue(preview);
  const { result } = renderHook(() => useOfflinePreview(config, "p1", "v3"));
  await tick();
  expect(result.current).toBeNull();
  const emit = () => {
    if (event === "mouse status") mouseStatus({ kind: "mouseOffline", active: false });
    else if (event === "battery") mouseBattery();
    else nativeMiceChanged();
  };
  act(emit);
  await tick();
  expect(result.current).toEqual(preview);
  const switched: OfflinePreview = { ...preview, target: { state: "written", bank: 1, playingBank: 2 } };
  vi.mocked(getOfflinePreview).mockResolvedValue(switched);
  act(emit);
  expect(result.current).toEqual(preview); // kept until the new read arrives
  await tick();
  expect(result.current).toEqual(switched);
  expect(getOfflinePreview).toHaveBeenLastCalledWith(config, "p1", "v3");
});

it("ignores unrelated status events and coalesces mouse events while dropping an older response", async () => {
  let resolveOld!: (value: OfflinePreview) => void;
  vi.mocked(getOfflinePreview).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue(preview);
  const { result } = renderHook(() => useOfflinePreview(config, "p1", "v3"));
  await tick();
  act(() => { mouseStatus({ kind: "helperLost", active: true }); });
  await act(async () => { resolveOld(preview); });
  expect(result.current).toEqual(preview);
  expect(getOfflinePreview).toHaveBeenCalledTimes(1);

  let resolveStale!: (value: OfflinePreview) => void;
  vi.mocked(getOfflinePreview).mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
  act(mouseBattery);
  await tick();
  act(() => { mouseStatus({ kind: "mouseOffline", active: true }); mouseBattery(); nativeMiceChanged(); });
  await act(async () => { resolveStale({ ...preview, target: { state: "unknown" } }); });
  // The stale answer is dropped; the last good preview stays until the new read.
  expect(result.current).toEqual(preview);
  await tick();
  expect(result.current).toEqual(preview);
  expect(getOfflinePreview).toHaveBeenCalledTimes(3);
});

it.each([
  { name: "mouse status", listen: listenMouseStatus },
  { name: "battery", listen: listenMouseBattery },
  { name: "native mice", listen: listenNativeMiceChanged },
])("disposes a late $name registration after unmount", async ({ listen }) => {
  let attach!: (dispose: () => void) => void;
  vi.mocked(listen).mockReturnValueOnce(new Promise((resolve) => { attach = resolve; }));
  const { unmount } = renderHook(() => useOfflinePreview(config, "p1", "v3"));
  await tick(0);
  const disposers = await Promise.all([listenMouseStatus, listenMouseBattery, listenNativeMiceChanged]
    .filter((other) => other !== listen).map((other) => vi.mocked(other).mock.results[0].value));
  unmount();
  for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
  const dispose = vi.fn();
  await act(async () => { attach(dispose); });
  expect(dispose).toHaveBeenCalledOnce();
  act(() => { mouseStatus({ kind: "mouseOffline", active: false }); mouseBattery(); nativeMiceChanged(); });
  await tick();
  expect(getOfflinePreview).not.toHaveBeenCalled();
});

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
