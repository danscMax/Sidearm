import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { MouseWorkspace } from "./MouseWorkspace";
import { makeConfig } from "../lib/test-fixtures";
import type { AppConfig } from "../lib/config";
import type { MouseSettings } from "../lib/onboard-mapping";
import * as backend from "../lib/backend";

vi.mock("../lib/backend", () => ({
  getMouseSettings: vi.fn(), getNativeModel: vi.fn(), getDeviceReport: vi.fn(),
  listenMouseBattery: vi.fn(), listenActionExecutionEvent: vi.fn(),
  setMouseDpi: vi.fn(), setMousePollRate: vi.fn(), setKeySignals: vi.fn(), openDeviceReportIssue: vi.fn(),
  normalizeCommandError: (error: unknown) => ({ message: String(error) }),
}));
const readings: MouseSettings = { batteryPercent: 63, dpi: 1100, pollRateHz: 500, status: "complete", warnings: [] };
const partial: MouseSettings = { ...readings, batteryPercent: null, status: "partial", warnings: [
  { field: "batteryPercent", message: { text: "Battery charge could not be read.", key: "mouseRead.batteryFailed" }, details: "query refused" },
] };
let batteryEvent: () => void;
let executionEvent: (event: { actionType: string; summary: { key: string } }) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(backend.getMouseSettings).mockResolvedValue(readings);
  vi.mocked(backend.getNativeModel).mockResolvedValue({ name: "Naga", connected: true, verified: true, consumerSignals: null, dpiMin: 100, dpiMax: 30000, pollRates: [125, 500, 1000] });
  vi.mocked(backend.listenMouseBattery).mockImplementation(async (callback) => { batteryEvent = () => callback({ percent: 63, low: false }); return vi.fn<() => void>(); });
  vi.mocked(backend.listenActionExecutionEvent).mockImplementation(async (_name, callback) => { executionEvent = callback as typeof executionEvent; return vi.fn<() => void>(); });
  vi.mocked(backend.getDeviceReport).mockResolvedValue("Sidearm diagnostic summary");
  vi.mocked(backend.setMouseDpi).mockResolvedValue(readings);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);

function show(overrides: Partial<AppConfig> = {}, runtimeProfileId?: string) {
  const config = { ...makeConfig(), ...overrides };
  const updates = vi.fn();
  const result = render(<MouseWorkspace activeConfig={config} profiles={config.profiles} activeProfile={config.profiles[0]}
    runtimeProfileId={runtimeProfileId ?? config.profiles[0].id} setSelectedProfileId={vi.fn()} updateDraft={updates} mouseStates={[]} />);
  return { ...result, config, updates };
}

describe("independent mouse readings", () => {
  it("selects Manual and focuses the existing input without writing settings or the mouse", async () => {
    const { updates } = show({ profiles: [{ ...makeConfig().profiles[0], mouseDpi: 1100 }] });
    await screen.findByText("1100 DPI");
    const manual = screen.getByRole("button", { name: "Manual" });
    fireEvent.click(manual);
    expect(manual.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "Sensitivity" }));
    expect(screen.getByRole("button", { name: "1100" }).getAttribute("aria-pressed")).toBe("false");
    expect(updates).not.toHaveBeenCalled();
    expect(backend.setMouseDpi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "1100" }));
    expect(manual.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "1100" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses one sensitivity input and shared preset pills, preserving assignments", async () => {
    vi.mocked(backend.setMouseDpi).mockResolvedValue({ ...readings, dpi: 800 });
    const { updates, config } = show({ profiles: [{ ...makeConfig().profiles[0], mouseDpi: 1100, mouseDpiStages: [800, 1100, 1600] }] });
    await screen.findByText("1100 DPI");
    expect(screen.queryByText("DPI stages")).toBeNull();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
    expect(screen.getByRole("spinbutton", { name: "Sensitivity" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "1100" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "800" }));
    await screen.findByText("800 DPI");
    const changed = updates.mock.calls[0][0](config) as AppConfig;
    expect(changed.profiles[0].mouseDpi).toBe(800);
    expect(changed.profiles[0].mouseDpiStages).toEqual([800, 1100, 1600]);
    expect(changed.bindings).toEqual(config.bindings);
    expect(changed.actions).toEqual(config.actions);
    expect(changed.settings).toEqual(config.settings);
  });

  it("keeps manual input usable with five presets and applies it with Enter", async () => {
    vi.mocked(backend.setMouseDpi).mockResolvedValue({ ...readings, dpi: 1200 });
    const { updates, config } = show({ profiles: [{ ...makeConfig().profiles[0], mouseDpi: 1100, mouseDpiStages: [400, 800, 1100, 1600, 3200] }] });
    await screen.findByText("1100 DPI");
    const input = screen.getByRole("spinbutton", { name: "Sensitivity" });
    fireEvent.change(input, { target: { value: "1200" } });
    expect(screen.getByRole("button", { name: "Manual" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("1200 DPI");
    const changed = updates.mock.calls[0][0](config) as AppConfig;
    expect(changed.profiles[0].mouseDpi).toBe(1200);
    expect(changed.profiles[0].mouseDpiStages).toEqual([400, 800, 1200, 1600, 3200]);
    expect(backend.setMouseDpi).toHaveBeenCalledWith(1200);
  });

  it("edits an inactive profile without changing the mouse or another profile", async () => {
    const first = { ...makeConfig().profiles[0], mouseDpi: 1100 };
    const other = { ...first, id: "other", name: "Other" };
    const { updates, config } = show({ profiles: [first, other] }, other.id);
    await screen.findByText("1100 DPI");
    fireEvent.click(screen.getByRole("button", { name: "800" }));
    const changed = updates.mock.calls[0][0](config) as AppConfig;
    expect(changed.profiles[0].mouseDpi).toBe(800);
    expect(changed.profiles[1]).toEqual(other);
    expect(backend.setMouseDpi).not.toHaveBeenCalled();
  });

  it("preserves DPI and polling when battery is unavailable, without mutating config", async () => {
    vi.mocked(backend.getMouseSettings).mockResolvedValue(partial);
    const { updates, config } = show();
    await screen.findByText("1100 DPI");
    expect(screen.getByText("500 Hz")).toBeTruthy();
    expect(screen.getByText("Battery charge could not be read.")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Own settings" }));
    const changed = updates.mock.calls[0][0](config) as AppConfig;
    expect(changed.profiles[0].mouseDpi).toBe(1100);
    expect(changed.profiles[0].mousePollRateHz).toBe(500);
    expect(config.profiles[0].mouseDpi).toBeUndefined();
  });

  it("does not seed guessed values from a battery-only snapshot", async () => {
    vi.mocked(backend.getMouseSettings).mockResolvedValue({ ...readings, dpi: null, pollRateHz: null, status: "partial" });
    show();
    await screen.findByText("63%");
    expect(screen.getByRole("checkbox", { name: "Own settings" }).hasAttribute("disabled")).toBe(true);
  });

  it("clears missing readings after disconnect and restores them on refresh", async () => {
    show();
    await screen.findByText("1100 DPI");
    vi.mocked(backend.getMouseSettings).mockResolvedValueOnce({ batteryPercent: null, dpi: null, pollRateHz: null, status: "disconnected", warnings: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/No supported mouse is connected/);
    expect(screen.queryByText("1100 DPI")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("1100 DPI");
  });

  it("ignores an old request after a DPI event and coalesces refreshes", async () => {
    let resolve!: (value: MouseSettings) => void;
    vi.mocked(backend.getMouseSettings).mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue({ ...readings, dpi: 1600 });
    show();
    await waitFor(() => expect(executionEvent).toBeTypeOf("function"));
    act(() => { executionEvent({ actionType: "mouseAction", summary: { key: "execution.dpiSwitched" } }); batteryEvent(); });
    await act(async () => resolve(readings));
    await screen.findByText("1600 DPI");
    expect(screen.queryByText("1100 DPI")).toBeNull();
    expect(backend.getMouseSettings).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed battery refresh turn a confirmed DPI write into failure", async () => {
    vi.mocked(backend.setMouseDpi).mockResolvedValue({ ...partial, dpi: 1200 });
    show({ profiles: [{ ...makeConfig().profiles[0], mouseDpi: 1100 }] });
    await screen.findByText("1100 DPI");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sensitivity" }), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/The setting was confirmed by the mouse/);
    expect(backend.setMouseDpi).toHaveBeenCalledTimes(1);
  });

  it("builds the summary without opening GitHub or writing the clipboard automatically", async () => {
    show();
    await screen.findByText("1100 DPI");
    fireEvent.click(screen.getByRole("button", { name: "Mouse diagnostics" }));
    await screen.findByRole("textbox", { name: "Mouse diagnostics" });
    expect(backend.getDeviceReport).toHaveBeenCalledWith("summary");
    expect(backend.openDeviceReportIssue).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await screen.findByText("Report copied.");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Sidearm diagnostic summary");
  });

  it("disposes late event subscriptions after leaving the workspace", async () => {
    let finish!: (dispose: () => void) => void;
    vi.mocked(backend.listenMouseBattery).mockReturnValueOnce(new Promise((done) => { finish = done; }));
    const { unmount } = show();
    unmount();
    const dispose = vi.fn();
    await act(async () => finish(dispose));
    expect(dispose).toHaveBeenCalledOnce();
  });
});
