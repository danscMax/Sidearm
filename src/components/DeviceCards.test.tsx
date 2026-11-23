import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { SidebarDeviceSection, type DeviceTab } from "./DeviceCards";
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
const pad = { id: "pad-1", name: "Macro Pad", builtin: false };
const mouse = (deviceId: string) => ({ deviceId, banks: deviceId === "razer-naga-v3" }) as NativeModelInfo;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

function show(
  connected: string[],
  activeDeviceId: string,
  opts: { devices?: typeof config.devices; onContextMenu?: (x: number, y: number) => void; onSelectTab?: (tab: DeviceTab) => void } = {},
) {
  vi.mocked(backend.listNativeMice).mockResolvedValue(connected.map(mouse));
  const onSelect = vi.fn();
  const onSelectTab = opts.onSelectTab ?? vi.fn<(tab: DeviceTab) => void>();
  const onAdd = vi.fn();
  const onContextMenu = opts.onContextMenu ?? vi.fn<(x: number, y: number) => void>();
  render(
    <SidebarDeviceSection
      config={config}
      devices={opts.devices ?? [v2, v3]}
      activeDeviceId={activeDeviceId}
      profile={null}
      refreshToken={0}
      workspaceMode="profiles"
      activeDeviceTab="buttons"
      onSelectDevice={onSelect}
      onSelectDeviceTab={onSelectTab}
      onAddDevice={onAdd}
      onDeviceContextMenu={onContextMenu}
    />,
  );
  return { onSelect, onSelectTab, onAdd, onContextMenu };
}

describe("sidebar universal device section (#2A)", () => {
  it("lists connected and disconnected devices inside the dropdown and supports switching", async () => {
    const { onSelect } = show([v2.id], v2.id);
    const picker = await screen.findByRole("button", { name: i18n.t("sidebar.selectDevice") });
    fireEvent.click(picker);
    expect(screen.getByText(i18n.t("device.offlineGroup"))).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: new RegExp(v3.name) }));
    expect(onSelect).toHaveBeenCalledWith(v3.id);
  });

  it("moves a default pick off an unplugged built-in mouse to a connected one", async () => {
    const { onSelect } = show([v3.id], v2.id);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(v3.id));
  });

  it("right-clicking the device picker opens its context menu at the pointer", async () => {
    const onContextMenu = vi.fn();
    show([v2.id, v3.id], v3.id, { onContextMenu });
    const picker = await screen.findByRole("button", { name: i18n.t("sidebar.selectDevice") });
    fireEvent.contextMenu(picker, { clientX: 30, clientY: 40 });
    expect(onContextMenu).toHaveBeenCalledWith(30, 40);
  });

  it("shows universal device sections cleanly: Statistics for any custom device, plus Memory & Sensor for native mice", async () => {
    const onSelectTab = vi.fn();
    show([v3.id], pad.id, { devices: [v3, pad], onSelectTab });
    // Custom device (Macro Pad): shows Assignments and Statistics, hides mouse-only Memory and Sensor tabs.
    expect(await screen.findByRole("button", { name: i18n.t("device.tabAssignments") })).toBeTruthy();
    expect(screen.getByRole("button", { name: i18n.t("device.tabStats") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: i18n.t("device.tabMemory") })).toBeNull();
    expect(screen.queryByRole("button", { name: i18n.t("device.tabPerformance") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("device.tabAssignments") }));
    expect(onSelectTab).toHaveBeenCalledWith("buttons");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("device.tabStats") }));
    expect(onSelectTab).toHaveBeenCalledWith("stats");
    cleanup();

    // Native mouse (V3 Pro): shows Assignments, Onboard memory, Sensor & DPI, and Statistics.
    show([v3.id], v3.id, { devices: [v3, pad], onSelectTab });
    expect(await screen.findByRole("button", { name: i18n.t("device.tabAssignments") })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("device.tabMemory")) })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("device.tabPerformance")) })).toBeTruthy();
    expect(screen.getByRole("button", { name: i18n.t("device.tabStats") })).toBeTruthy();
  });
});
