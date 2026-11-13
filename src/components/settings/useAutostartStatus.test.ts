import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getAdminAutostartStatus, setAdminAutostart } from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import { makeConfig } from "../../lib/test-fixtures";
import { useAutostartStatus } from "./useAutostartStatus";

vi.mock("@tauri-apps/plugin-autostart", () => ({ disable: vi.fn(), enable: vi.fn(), isEnabled: vi.fn() }));
vi.mock("../../lib/backend", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/backend")>(),
  getAdminAutostartStatus: vi.fn(),
  setAdminAutostart: vi.fn(),
}));

const adminStatus = {
  enabled: false, supported: true, registeredPath: null, currentExe: "E:\\Sidearm.exe",
  pathMismatch: false, needsReconfirm: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(disable).mockResolvedValue(undefined);
  vi.mocked(enable).mockResolvedValue(undefined);
  vi.mocked(getAdminAutostartStatus).mockResolvedValue(adminStatus);
});
afterEach(cleanup);

async function mountAutostart() {
  const saved = { current: makeConfig() };
  saved.current.settings.startWithWindows = true;
  const updateDraft = vi.fn((updater: (config: AppConfig) => AppConfig) => { saved.current = updater(saved.current); });
  const setError = vi.fn();
  const hook = renderHook(() => useAutostartStatus(updateDraft, setError));
  await waitFor(() => expect(hook.result.current.runAtLogon).toBe(true));
  return { ...hook, saved, updateDraft, setError };
}

describe("regular autostart disable confirmation", () => {
  it.each(["still enabled", "probe failed"])("keeps autostart enabled and surfaces disable errors when %s", async (state) => {
    const { result, saved, updateDraft, setError } = await mountAutostart();
    vi.mocked(disable).mockRejectedValueOnce("Access denied");
    if (state === "probe failed") vi.mocked(isEnabled).mockRejectedValueOnce("Probe failed");
    await act(async () => { await result.current.handleRunAtLogonToggle(false); });
    expect(result.current.runAtLogon).toBe(true);
    expect(saved.current.settings.startWithWindows).toBe(true);
    expect(updateDraft).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith({ code: "command_error", message: "Access denied" });
    expect(result.current.autostartBusy).toBe(false);
  });

  it("accepts a failed disable only when the OS confirms it is already disabled", async () => {
    const { result, saved, setError } = await mountAutostart();
    vi.mocked(disable).mockRejectedValueOnce("Already disabled");
    vi.mocked(isEnabled).mockResolvedValueOnce(false);
    await act(async () => { await result.current.handleRunAtLogonToggle(false); });
    expect(isEnabled).toHaveBeenCalledTimes(2);
    expect(result.current.runAtLogon).toBe(false);
    expect(saved.current.settings.startWithWindows).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("saves a successful regular disable", async () => {
    const { result, saved, setError } = await mountAutostart();
    await act(async () => { await result.current.handleRunAtLogonToggle(false); });
    expect(result.current.runAtLogon).toBe(false);
    expect(saved.current.settings.startWithWindows).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces failure to remove the regular entry while switching to admin autostart", async () => {
    const { result, saved, setError } = await mountAutostart();
    vi.mocked(setAdminAutostart).mockResolvedValueOnce({ ...adminStatus, enabled: true });
    vi.mocked(disable).mockRejectedValueOnce("Access denied");
    await act(async () => { await result.current.handleRunAsAdminToggle(true); });
    expect(result.current.adminAutostart?.enabled).toBe(true);
    expect(saved.current.settings.startWithWindows).toBe(true);
    expect(setError).toHaveBeenCalledWith({ code: "command_error", message: "Access denied" });
  });
});
