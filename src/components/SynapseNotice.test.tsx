import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OnboardTakeoverEvent } from "../lib/onboard-mapping";
import { SynapseNotice } from "./SynapseNotice";

const api = vi.hoisted(() => ({
  getSynapseStatus: vi.fn(), recoverFromSynapse: vi.fn(), restoreOnboardControl: vi.fn(),
  restoreSynapseStartup: vi.fn(), openStartupAppsSettings: vi.fn(),
  listener: null as null | ((event: OnboardTakeoverEvent) => void),
  unlisten: vi.fn(),
}));
vi.mock("../lib/backend", () => ({
  ...api,
  listenOnboardTakeover: (fn: (event: OnboardTakeoverEvent) => void) => {
    api.listener = fn;
    return Promise.resolve(api.unlisten);
  },
  normalizeCommandError: (e: unknown) => ({ message: e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String(e.message) : String(e) }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.listener = null;
  api.getSynapseStatus.mockResolvedValue({ running: true, startupRestoreAvailable: false });
  api.recoverFromSynapse.mockResolvedValue({ startupDisabled: false, startupError: null });
});
afterEach(cleanup);

async function showConflict() {
  render(<SynapseNotice enabled />);
  return screen.findByRole("button", { name: "Закрыть Synapse и настроить Sidearm" });
}

describe("Synapse recovery card", () => {
  it("merges driver and mapping events, keeps startup opt-in, and never closes Razer automatically", async () => {
    await showConflict();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    act(() => {
      api.listener?.({ kind: "mode", restored: false, controls: [] });
      api.listener?.({ kind: "mappings", restored: true, controls: ["mouse_right"] });
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Razer также изменил назначения кнопок.")).toBeTruthy();
    expect(api.recoverFromSynapse).not.toHaveBeenCalled();
  });

  it("disables duplicate repairs and requests a physical test before success", async () => {
    const button = await showConflict();
    let finish!: (value: { startupDisabled: boolean; startupError: null }) => void;
    api.recoverFromSynapse.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.recoverFromSynapse).toHaveBeenCalledExactlyOnceWith(false, true);
    expect(screen.queryByText("Да, работает")).toBeNull();
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: false });
    await act(async () => { finish({ startupDisabled: false, startupError: null }); });
    expect(screen.getByText(/Назначения записаны/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Да, работает" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("preserves a partial startup failure and offers undo without claiming startup success", async () => {
    const button = await showConflict();
    fireEvent.click(screen.getByRole("checkbox"));
    api.recoverFromSynapse.mockResolvedValue({ startupDisabled: false, startupError: { code: "denied", message: "Access denied" } });
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: true });
    fireEvent.click(button);
    await screen.findByText(/автозапуск изменить не удалось/);
    expect(api.recoverFromSynapse).toHaveBeenCalledWith(true, true);
    expect(screen.getByRole("button", { name: "Вернуть прежний автозапуск" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Да, работает" }));
    expect(screen.getByText(/автозапуск изменить не удалось/)).toBeTruthy();
  });

  it("retains a failed recovery and renews the conflict when Razer starts again", async () => {
    const button = await showConflict();
    api.recoverFromSynapse.mockRejectedValue(new Error("Mouse asleep"));
    fireEvent.click(button);
    await screen.findByText(/Mouse asleep/);
    expect(screen.queryByText("Да, работает")).toBeNull();
    act(() => api.listener?.({ kind: "razerStarted", restored: true, controls: [] }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("does not poll or display a conflict while Sidearm is stopped", async () => {
    render(<SynapseNotice enabled={false} />);
    expect(api.getSynapseStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not skip physical verification when startup is undone during the test step", async () => {
    const button = await showConflict();
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: true });
    fireEvent.click(button);
    await screen.findByText(/Назначения записаны/);
    api.restoreSynapseStartup.mockResolvedValue(undefined);
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: false });
    fireEvent.click(screen.getByRole("button", { name: "Вернуть прежний автозапуск" }));
    await waitFor(() => expect(api.restoreSynapseStartup).toHaveBeenCalledOnce());
    await screen.findByRole("button", { name: "Да, работает" });
    expect(screen.queryByText("Проверка завершена.")).toBeNull();
  });

  it("does not claim a completed check when the process snapshot is unavailable", async () => {
    api.getSynapseStatus.mockRejectedValue(new Error("Process list unavailable"));
    render(<SynapseNotice enabled />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Проверка завершена.")).toBeNull();
    expect(api.recoverFromSynapse).not.toHaveBeenCalled();
  });

  it("does not grant process-close permission for a mapping-only repair", async () => {
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: false });
    render(<SynapseNotice enabled />);
    await act(async () => {});
    act(() => api.listener?.({ kind: "mappings", restored: false, controls: ["mouse_right"] }));
    fireEvent.click(screen.getByRole("button", { name: "Вернуть управление" }));
    await screen.findByText(/Назначения записаны/);
    expect(api.recoverFromSynapse).toHaveBeenCalledExactlyOnceWith(false, false);
  });

  it("makes a new takeover actionable after a confirmed physical test", async () => {
    const button = await showConflict();
    api.getSynapseStatus.mockResolvedValue({ running: false, startupRestoreAvailable: false });
    fireEvent.click(button);
    await screen.findByText(/Назначения записаны/);
    fireEvent.click(screen.getByRole("button", { name: "Да, работает" }));
    act(() => api.listener?.({ kind: "mode", restored: false, controls: [] }));
    expect(screen.getByRole("button", { name: "Вернуть управление" })).toBeTruthy();
  });

  it("removes its event listener on unmount", async () => {
    const { unmount } = render(<SynapseNotice enabled />);
    await screen.findByRole("checkbox");
    unmount();
    await waitFor(() => expect(api.unlisten).toHaveBeenCalledOnce());
  });
});
