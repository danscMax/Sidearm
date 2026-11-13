import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { RAZER_NAGA_DEVICE_ID } from "../lib/config";
import { NAGA_V3_DEVICE_ID } from "../lib/devices";
import { makeAction, makeConfig } from "../lib/test-fixtures";
import { DeviceTransferModal } from "./DeviceTransferModal";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

it("counts only checked hold offers that still belong to the current scope", () => {
  const config = makeConfig({
    actions: [makeAction({ type: "mouseAction", payload: { action: "mouseBack" } })],
    bindings: ["p1", "p2"].map((profileId) => ({ id: profileId, profileId, controlId: "v3_thumb_01", layer: "hypershift2", actionId: "a1", enabled: true, label: `Offer ${profileId}` })),
  });
  config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "V3", builtin: true });
  config.physicalControls.push({ ...config.physicalControls[1], id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID });
  const onApply = vi.fn();
  render(<DeviceTransferModal config={config} activeDeviceId={RAZER_NAGA_DEVICE_ID} activeProfileId="p1" allProfiles
    onApply={onApply} onSyncChange={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByLabelText(/Offer p2/));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("transfer.scopeProfile", { name: "Default" }) }));
  const apply = screen.getByRole("button", { name: i18n.t("transfer.holdsApply", { count: 0 }) });
  expect(apply.hasAttribute("disabled")).toBe(true);
  fireEvent.click(apply);
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/Offer p1/));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("transfer.holdsApply", { count: 1 }) }));
  expect(onApply).toHaveBeenCalledOnce();
  const [next, count] = onApply.mock.calls[0];
  expect(count).toBe(1);
  expect(next.bindings.slice(config.bindings.length)).toEqual([expect.objectContaining({ profileId: "p1", controlId: "thumb_01", triggerMode: "longPress" })]);
});
