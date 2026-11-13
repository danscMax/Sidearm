import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../lib/backend";
import type { AppConfig, LoadConfigResponse } from "../lib/config";
import { makeConfig } from "../lib/test-fixtures";
import { useAppPersistence } from "../hooks/useAppPersistence";

vi.mock("../lib/backend", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/backend")>(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  verifyOnboardMapping: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

function response(config: AppConfig): LoadConfigResponse {
  return { config, warnings: [], path: "E:\\test\\config.json", createdDefault: false };
}

function pendingLoad() {
  let resolve!: (result: LoadConfigResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<LoadConfigResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function ready() {
  const base = makeConfig();
  vi.mocked(loadConfig).mockResolvedValueOnce(response(base));
  const hook = renderHook(() => useAppPersistence());
  await act(async () => { await hook.result.current.refreshConfig(); });
  return { ...hook, base };
}

describe("config revision for asynchronous imports", () => {
  it("invalidates synchronously through an old getter and recovers after a failed reload", async () => {
    const { result, base } = await ready();
    const getRevision = result.current.getConfigRevision;
    expect(getRevision?.()).toBe(1);
    const load = pendingLoad();
    vi.mocked(loadConfig).mockReturnValueOnce(load.promise);
    let refresh!: Promise<boolean>;
    act(() => {
      refresh = result.current.refreshConfig();
      expect(getRevision?.()).toBeNull();
    });
    await act(async () => {
      load.reject("Reload failed");
      expect(await refresh).toBe(false);
    });
    expect(getRevision?.()).toBe(2);
    expect(result.current.activeConfig).toBe(base);
  });

  it("stays unavailable after load completes until its config commits", async () => {
    const { result, base } = await ready();
    const getRevision = result.current.getConfigRevision;
    const next = makeConfig({ version: 2 });
    vi.mocked(loadConfig).mockResolvedValueOnce(response(next));
    await act(async () => {
      expect(await result.current.refreshConfig()).toBe(true);
      expect(result.current.activeConfig).toBe(base);
      expect(getRevision?.()).toBeNull();
    });
    expect(result.current.activeConfig).toBe(next);
    expect(getRevision?.()).toBe(2);
  });

  it.each(["success", "failure"])("keeps a later reload pending after the earlier reload's %s", async (outcome) => {
    const { result } = await ready();
    const getRevision = result.current.getConfigRevision;
    const first = pendingLoad();
    const second = pendingLoad();
    vi.mocked(loadConfig).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let firstRefresh!: Promise<boolean>;
    let secondRefresh!: Promise<boolean>;
    act(() => {
      firstRefresh = result.current.refreshConfig();
      secondRefresh = result.current.refreshConfig();
    });
    await act(async () => {
      if (outcome === "success") first.resolve(response(makeConfig({ version: 2 })));
      else first.reject("Earlier reload failed");
      expect(await firstRefresh).toBe(outcome === "success");
    });
    expect(getRevision?.()).toBeNull();
    const latest = makeConfig({ version: 3 });
    await act(async () => {
      second.resolve(response(latest));
      expect(await secondRefresh).toBe(true);
      expect(getRevision?.()).toBeNull();
    });
    expect(result.current.activeConfig).toBe(latest);
    expect(getRevision?.()).toBe(3);
  });

  it("tracks reloads requested through refreshAfterSave", async () => {
    const { result } = await ready();
    const getRevision = result.current.getConfigRevision;
    const load = pendingLoad();
    vi.mocked(loadConfig).mockReturnValueOnce(load.promise);
    let refresh!: Promise<boolean>;
    act(() => {
      refresh = result.current.refreshAfterSave();
      expect(getRevision?.()).toBeNull();
    });
    await act(async () => { load.resolve(response(makeConfig())); await refresh; });
    expect(getRevision?.()).toBe(2);
  });

  it("becomes available when a reload reuses the committed config object", async () => {
    const { result, base } = await ready();
    const getRevision = result.current.getConfigRevision;
    vi.mocked(loadConfig).mockResolvedValueOnce(response(base));
    await act(async () => { await result.current.refreshConfig(); });
    expect(result.current.activeConfig).toBe(base);
    expect(getRevision?.()).toBe(2);
  });
});
