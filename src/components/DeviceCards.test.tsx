import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { DeviceCards } from "./DeviceCards";
import { makeConfig } from "../lib/test-fixtures";
import type { NativeModelInfo } from "../lib/onboard-mapping";
import * as backend from "../lib/backend";

vi.mock("../lib/backend", () => ({
  getMouseSettings: vi.fn(async () => null),
  listNativeMice: vi.fn(),
  listenNativeMiceChanged: vi.fn(async () => () => {}),
  listenMouseBattery: vi.fn(async () => () => {}),
  listenActionExecutionEvent: vi.fn(async () => () => {}),
}));

const config = makeConfig();
const v2 = config.devices[0];
const v3 = { ...v2, id: "razer-naga-v3", name: "Razer Naga V3 Pro" };
const mouse = (deviceId: string) => ({ deviceId }) as NativeModelInfo;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

function show(connected: string[], activeDeviceId: string) {
  vi.mocked(backend.listNativeMice).mockResolvedValue(connected.map(mouse));
  const onSelect = vi.fn();
  render(<DeviceCards config={config} devices={[v2, v3]} activeDeviceId={activeDeviceId} profile={null}
    refreshToken={0} onSelect={onSelect} onAdd={vi.fn()} />);
  return onSelect;
}

describe("device cards", () => {
  it("folds a mouse that is not connected and shows it on request", async () => {
    show([v2.id], v2.id);
    const more = await screen.findByRole("button", { name: "+1 not connected" });
    expect(screen.queryByTitle(v3.name)).toBeNull();
    fireEvent.click(more);
    expect(screen.getByTitle(v3.name)).toBeTruthy();
  });

  it("moves a default pick off an unplugged mouse to the connected one", async () => {
    const onSelect = show([v3.id], v2.id);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(v3.id));
  });

  it("offers adding a device when no supported mouse is connected", async () => {
    show([], "custom");
    expect(await screen.findByText("No supported mouse found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+2 not connected" })).toBeTruthy();
  });
});
