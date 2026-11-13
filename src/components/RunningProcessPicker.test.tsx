import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { listRunningProcesses } from "../lib/backend";
import type { RunningProcessInfo } from "../lib/config";
import { RunningProcessPicker } from "./RunningProcessPicker";

vi.mock("../lib/backend", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/backend")>(),
  listRunningProcesses: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

function pendingList() {
  let resolve!: (list: RunningProcessInfo[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RunningProcessInfo[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const editor = { exe: "editor.exe", path: "E:\\Editor\\editor.exe", pid: 12 };
const stale = { exe: "stale.exe", path: "E:\\stale.exe", pid: 10 };

describe("process picker request lifetime", () => {
  it("loads in StrictMode and ignores an earlier successful reply", async () => {
    const first = pendingList();
    const current = pendingList();
    vi.mocked(listRunningProcesses).mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise);
    const pick = vi.fn();
    render(<StrictMode><RunningProcessPicker onPick={pick} onCancel={vi.fn()} /></StrictMode>);
    await act(async () => { current.resolve([editor]); });
    expect(screen.queryByText(i18n.t("processPicker.loading"))).toBeNull();
    expect(screen.getByRole("button", { name: /editor.exe/ })).toBeTruthy();
    await act(async () => { first.resolve([stale]); });
    expect(screen.queryByRole("button", { name: /stale.exe/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /editor.exe/ }));
    expect(pick).toHaveBeenCalledWith(editor);
  });

  it("ignores stale errors without ending the current load, then allows retry of a real error", async () => {
    const first = pendingList();
    const current = pendingList();
    vi.mocked(listRunningProcesses).mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise)
      .mockResolvedValueOnce([editor]);
    const setError = vi.fn();
    const props = { onPick: vi.fn(), onCancel: vi.fn(), setError };
    const { rerender } = render(<RunningProcessPicker {...props} />);
    const latestSetError = vi.fn();
    rerender(<RunningProcessPicker {...props} setError={latestSetError} />);
    await act(async () => { first.reject("Stale failure"); });
    expect(screen.getByText(i18n.t("processPicker.loading"))).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(setError).not.toHaveBeenCalled();
    await act(async () => { current.reject("Current failure"); });
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("processPicker.loadError"));
    expect(latestSetError).toHaveBeenCalledWith({ code: "command_error", message: "Current failure" });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: i18n.t("processPicker.refresh") })[0]); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /editor.exe/ })).toBeTruthy();
  });

  it("does not report a late failure after unmount", async () => {
    const request = pendingList();
    vi.mocked(listRunningProcesses).mockReturnValueOnce(request.promise);
    const setError = vi.fn();
    const { unmount } = render(<RunningProcessPicker onPick={vi.fn()} onCancel={vi.fn()} setError={setError} />);
    unmount();
    await act(async () => { request.reject("Late failure"); });
    expect(setError).not.toHaveBeenCalled();
  });
});
