import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import * as backend from "../../lib/backend";
import type { EncodedKeyEvent } from "../../lib/runtime";
import { makeConfig } from "../../lib/test-fixtures";
import { OnboardingWizard } from "./OnboardingWizard";

vi.mock("../../lib/backend", () => ({
  startRuntime: vi.fn(async () => undefined),
  checkSynapseInstalled: vi.fn(async () => false),
  getNagaV3CaptureReady: vi.fn(async () => true),
  listenEncodedKeyEvent: vi.fn(),
  listenActionExecutionEvent: vi.fn(async () => () => {}),
  setInputCaptureMode: vi.fn(async () => undefined),
  restoreOnboardControl: vi.fn(),
}));

afterEach(cleanup);

it("confirms a V3 on its own HID signal in both layers without writing the V2 profile", async () => {
  await i18n.changeLanguage("en");
  let receive = (_event: EncodedKeyEvent) => {};
  vi.mocked(backend.listenEncodedKeyEvent).mockImplementation(async (_name, callback) => {
    receive = callback;
    return () => {};
  });
  const config = makeConfig({
    encoderMappings: [
      { controlId: "v3_thumb_01", layer: "standard", encodedKey: "F13", source: "reserved", verified: true },
      { controlId: "v3_top_aux_02", layer: "standard", encodedKey: "F14", source: "reserved", verified: true },
    ],
  });
  config.devices.push({ id: "razer-naga-v3", name: "Razer Naga V3 Pro", builtin: true });
  const save = vi.fn();
  vi.mocked(backend.checkSynapseInstalled).mockResolvedValueOnce(true);
  render(<OnboardingWizard config={config} applyConfig={save} onClose={vi.fn()} />);
  await screen.findByText(/Synapse is running/);
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  expect(backend.startRuntime).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByText(/Synapse is closed/);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("heading", { name: "Getting your mouse ready" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Razer Naga thumb grid" })).toBeNull();
  expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(true, true);

  const event = { encodedKey: "F13", receivedAt: 0, isRepeat: false, isKeyUp: false };
  expect(screen.getByText(/Wait before pressing any buttons/)).toBeTruthy();
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: false }));
  await screen.findByText("Press side button 1 on its own.");
  expect(screen.getByRole("img", { name: "Razer Naga thumb grid" })).toBeTruthy();
  act(() => receive({ ...event, backend: "windows-hotkey", isHypershift: false }));
  expect(screen.getByText("On its own · 0 of 1")).toBeTruthy();
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: false }));
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Hold the separate button on the right edge/)).toBeTruthy();
  fireEvent.blur(window);
  fireEvent.focus(window);
  expect(screen.getByText("On its own · 1 of 1")).toBeTruthy();
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: false }));
  expect(screen.getByText(/Side button 1 was pressed on its own/)).toBeTruthy();
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: true }));
  expect(screen.queryByText(/Side button 1 was pressed on its own/)).toBeNull();
  expect(screen.getByText("With the ring-finger button held · 1 of 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check the full panel · 24 presses" }));
  expect(screen.getByText("On its own · 1 of 12")).toBeTruthy();
  expect(screen.getByText("With the ring-finger button held · 1 of 12")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Return to the quick check" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("heading", { name: "Check the top buttons and wheel" })).toBeTruthy();
  expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(true, true);
  act(() => receive({ ...event, encodedKey: "F14", backend: "windows-hid-naga-v3", isHypershift: false }));
  expect(screen.getByText("Checked · 1 of 10")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip this check" }));
  expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(false, true);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(save).toHaveBeenCalledWith({ ...config, settings: { ...config.settings, onboardingCompleted: true } });
  expect(backend.restoreOnboardControl).not.toHaveBeenCalled();
});
