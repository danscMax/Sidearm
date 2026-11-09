import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import * as backend from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import { deviceLayout, NAGA_V3_DEVICE_ID } from "../../lib/devices";
import type { NativeModelInfo } from "../../lib/onboard-mapping";
import type { EncodedKeyEvent } from "../../lib/runtime";
import { makeConfig } from "../../lib/test-fixtures";
import { OnboardingWizard, thumbOf, wizardSteps } from "./OnboardingWizard";

vi.mock("../../lib/backend", () => ({
  startRuntime: vi.fn(async () => undefined),
  getSynapseStatus: vi.fn(async () => ({ running: false, startupRestoreAvailable: false })),
  recoverFromSynapse: vi.fn(async () => ({ startupDisabled: false, startupError: null })),
  listNativeMice: vi.fn(async () => []),
  listenNativeMiceChanged: vi.fn(async () => () => {}),
  getLiveMapReady: vi.fn(async () => true),
  isRunningAsAdmin: vi.fn(async () => true),
  getAdminAutostartStatus: vi.fn(async () => ({ enabled: false })),
  listenEncodedKeyEvent: vi.fn(async () => () => {}),
  listenActionExecutionEvent: vi.fn(async () => () => {}),
  setInputCaptureMode: vi.fn(async () => undefined),
  restoreOnboardControl: vi.fn(async () => undefined),
  relaunchAsAdmin: vi.fn(),
  setAdminAutostart: vi.fn(),
  normalizeCommandError: (error: unknown) => ({ message: String(error) }),
}));

const mouse = (deviceId: string, name: string, verified = true): NativeModelInfo => ({
  name, deviceId, verified, connected: true, banks: false, consumerSignals: true, dpiMin: 100, dpiMax: 30000, pollRates: [1000],
});
const V2 = mouse("razer-naga", "Razer Naga V2 HyperSpeed");
const V3 = mouse(NAGA_V3_DEVICE_ID, "Razer Naga V3 Pro");

function configWithV3(): AppConfig {
  const config = makeConfig({
    encoderMappings: [
      { controlId: "thumb_01", layer: "standard", encodedKey: "F13", source: "reserved", verified: true },
      { controlId: "v3_thumb_01", layer: "standard", encodedKey: "Ctrl+Shift+F13", source: "reserved", verified: true },
      { controlId: "v3_top_aux_02", layer: "standard", encodedKey: "Ctrl+Shift+F14", source: "reserved", verified: true },
    ],
  });
  config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "Razer Naga V3 Pro", builtin: true });
  for (const id of ["v3_thumb_01", "v3_top_aux_02"]) {
    config.physicalControls.push({ id, deviceId: NAGA_V3_DEVICE_ID, family: "thumbGrid", defaultName: id, remappable: true, capabilityStatus: "verified" });
  }
  return config;
}

let receive: (event: EncodedKeyEvent) => void = () => {};
const press = (encodedKey: string, backendTag: string, isHypershift = false) =>
  act(() => receive({ encodedKey, backend: backendTag, isHypershift, receivedAt: 0, isRepeat: false, isKeyUp: false }));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(backend.listenEncodedKeyEvent).mockImplementation(async (_name, callback) => {
    receive = callback;
    return () => {};
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("setup steps follow the mouse", () => {
  it("writes onboard memory only on the onboard path and checks only verified models", () => {
    expect(wizardSteps(V2, deviceLayout("razer-naga"))).toEqual(["welcome", "mouse", "live", "admin", "tryit"]);
    expect(wizardSteps(V3, deviceLayout(NAGA_V3_DEVICE_ID))).toEqual(["welcome", "live", "extras", "admin", "tryit"]);
    expect(wizardSteps(mouse("razer-naga", "Razer Naga X", false), deviceLayout("razer-naga"))).toEqual(["welcome", "admin", "tryit"]);
    expect(wizardSteps(null, undefined)).toEqual(["welcome", "admin", "tryit"]);
  });

  it("counts a press for the mouse whose control sends it", () => {
    const config = configWithV3();
    expect(thumbOf(config, NAGA_V3_DEVICE_ID, "Ctrl+Shift+F13")).toEqual({ button: 1, hypershift: false });
    expect(thumbOf(config, NAGA_V3_DEVICE_ID, "F13")).toBeNull();
    expect(thumbOf(config, "razer-naga", "F13")).toEqual({ button: 1, hypershift: false });
  });
});

describe("the setup wizard", () => {
  it("asks which mouse to set up when two are connected", async () => {
    vi.mocked(backend.listNativeMice).mockResolvedValue([V2, V3]);
    render(<OnboardingWizard config={configWithV3()} applyConfig={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText(/Two mice are connected/);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("Razer Naga V3 Pro"));
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Check the side buttons" });
    expect(backend.restoreOnboardControl).not.toHaveBeenCalled();
  });

  it("closes a running Synapse on request, then lets the user go on", async () => {
    vi.mocked(backend.listNativeMice).mockResolvedValue([V3]);
    vi.mocked(backend.getSynapseStatus)
      .mockResolvedValueOnce({ running: true, startupRestoreAvailable: false })
      .mockResolvedValueOnce({ running: false, startupRestoreAvailable: false });
    render(<OnboardingWizard config={configWithV3()} applyConfig={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Razer Synapse" }));
    await screen.findByText("not running");
    expect(backend.startRuntime).toHaveBeenCalled();
    expect(backend.recoverFromSynapse).toHaveBeenCalledWith(false, true);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });

  it("checks a V3 on its own stream in both layers", async () => {
    vi.mocked(backend.listNativeMice).mockResolvedValue([V3]);
    const save = vi.fn();
    const onClose = vi.fn();
    const config = configWithV3();
    render(<OnboardingWizard config={config} applyConfig={save} onClose={onClose} />);
    await screen.findByText("Razer Naga V3 Pro");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Press side button 1 on its own.");
    expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(true, true);
    press("F13", "hid:razer-naga");
    press("F13", "windows-ll-hook");
    expect(screen.getByText("On its own · 0 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip the check" })).toBeTruthy();
    press("Ctrl+Shift+F13", `hid:${NAGA_V3_DEVICE_ID}`);
    expect(screen.getByText("On its own · 1 of 1")).toBeTruthy();
    press("Ctrl+Shift+F13", `hid:${NAGA_V3_DEVICE_ID}`);
    expect(screen.getByText(/Side button 1 was pressed on its own/)).toBeTruthy();
    press("Ctrl+Shift+F13", `hid:${NAGA_V3_DEVICE_ID}`, true);
    expect(screen.getByText(/Both ways of pressing the buttons are confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Check the top buttons and wheel" })).toBeTruthy();
    press("Ctrl+Shift+F14", `hid:${NAGA_V3_DEVICE_ID}`);
    expect(screen.getByText("Checked · 1 of 10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip this check" }));
    expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(false, true);
    expect(screen.getByRole("heading", { name: "Working in administrator windows" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(save).toHaveBeenCalledWith({ ...config, settings: { ...config.settings, onboardingCompleted: true, onboardingStep: undefined } });
    expect(onClose).toHaveBeenCalledWith(NAGA_V3_DEVICE_ID);
  });

  it("offers a way out when the mouse never gets ready", async () => {
    vi.mocked(backend.listNativeMice).mockResolvedValue([V3]);
    vi.mocked(backend.getLiveMapReady).mockResolvedValue(false);
    render(<OnboardingWizard config={configWithV3()} applyConfig={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Getting your mouse ready" });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByRole("heading", { name: "The mouse does not answer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip the check" }).hasAttribute("disabled")).toBe(false);
  });

  it("goes on without a mouse and skips the checks", async () => {
    vi.mocked(backend.listNativeMice).mockResolvedValue([]);
    render(<OnboardingWizard config={makeConfig()} applyConfig={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText(/No supported Razer Naga is connected/);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Working in administrator windows" })).toBeTruthy();
  });
});
