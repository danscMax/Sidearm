import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import * as backend from "../../lib/backend";
import type { EncodedKeyEvent } from "../../lib/runtime";
import { makeConfig } from "../../lib/test-fixtures";
import { OnboardingWizard } from "./OnboardingWizard";

vi.mock("../../lib/backend", () => ({
  startRuntime: vi.fn(async () => undefined),
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
    encoderMappings: [{
      controlId: "v3_thumb_01", layer: "standard", encodedKey: "F13", source: "reserved", verified: true,
    }],
  });
  config.devices.push({ id: "razer-naga-v3", name: "Razer Naga V3 Pro", builtin: true });
  const save = vi.fn();
  render(<OnboardingWizard config={config} applyConfig={save} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("heading", { name: "Check both layers" })).toBeTruthy();
  expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(true);

  const event = { encodedKey: "F13", receivedAt: 0, isRepeat: false, isKeyUp: false };
  act(() => receive({ ...event, backend: "windows-hotkey", isHypershift: false }));
  expect(screen.getByRole("status").textContent).toContain("0 of 2");
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: false }));
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  act(() => receive({ ...event, backend: "windows-hid-naga-v3", isHypershift: true }));
  expect(screen.getByRole("status").textContent).toContain("2 of 2");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(backend.setInputCaptureMode).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(save).toHaveBeenCalledWith({ ...config, settings: { ...config.settings, onboardingCompleted: true } });
  expect(backend.restoreOnboardControl).not.toHaveBeenCalled();
});
