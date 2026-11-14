import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { startTransition, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { AppConfig, AppMapping, Layer } from "../lib/config";
import { NAGA_V3_DEVICE_ID } from "../lib/devices";
import { resolveInitialControlId } from "../lib/helpers";
import { makeAction, makeConfig } from "../lib/test-fixtures";
import { ProfilesWorkspace, type ProfilesWorkspaceProps } from "./ProfilesWorkspace";

vi.mock("./DeviceCards", () => ({
  DeviceCards: ({ onContextMenu }: { onContextMenu?: (x: number, y: number) => void }) =>
    <button type="button" onClick={() => onContextMenu?.(0, 0)}>device card menu</button>,
}));
vi.mock("./MouseVisualization", () => ({ MouseVisualization: () => null }));
vi.mock("./ExeIcon", () => ({ ExeIcon: () => null }));
vi.mock("./AppMappingModal", () => ({ AppMappingModal: () => null }));
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

function workspaceProps(config: AppConfig, extra: Partial<ProfilesWorkspaceProps> = {}) {
  const props: ProfilesWorkspaceProps = {
    activeConfig: config, activeProfile: config.profiles[0], effectiveProfileId: "p1",
    addRuleSignal: false, onAddRuleHandled: vi.fn(), transferSignal: false, onTransferHandled: vi.fn(),
    ruleSignal: null, onRuleSignalHandled: vi.fn(), allProfilesView: false,
    quickRuleCapture: null, onQuickRuleHandled: vi.fn(), lastCapture: null, captureDelayMs: 0,
    viewState: "ready", updateDraft: vi.fn(), setCaptureDelayMs: vi.fn(), setConfirmModal: vi.fn(),
    handleCaptureActiveWindow: vi.fn(async () => {}), setProfileSyncSuppressed: vi.fn(),
    familySections: [], devices: config.devices, activeDeviceId: config.devices[0].id,
    onSelectDevice: vi.fn(), selectedLayer: "standard", multiSelectedControlIds: new Set(),
    onSelectLayer: vi.fn(), setSelectedProfileId: vi.fn(), setSelectedControlId: vi.fn(),
    setMultiSelectedControlIds: vi.fn(), setActionPickerBindingId: vi.fn(), setActionPickerOpen: vi.fn(),
    showToast: vi.fn(), runtimeProfileId: "p1", mouseStates: [], ...extra,
  };
  return props;
}

function show(config: AppConfig, extra: Partial<ProfilesWorkspaceProps> = {}) {
  const props = workspaceProps(config, extra);
  render(<ProfilesWorkspace {...props} />);
  return props;
}

const rule: AppMapping = { id: "r1", profileId: "p1", exe: "python.exe", processPath: "C:\\envA\\python.exe", titleIncludes: [" Project ", "regex:foo $"], enabled: false, priority: 10 };

it("duplicates the complete disabled rule instead of creating a capture rule", () => {
  const config = makeConfig({ appMappings: [rule] });
  const props = show(config, { ruleSignal: { mappingId: rule.id, at: { x: 0, y: 0 } } });
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  const updater = vi.mocked(props.updateDraft).mock.calls[0][0];
  const result = updater(config);
  expect(result.appMappings).toHaveLength(2);
  expect(result.appMappings[1]).toEqual({ ...rule, id: expect.any(String) });
  expect(result.appMappings[1].id).not.toBe(rule.id);
});

it("selects the result's device before selecting its control in all-profile search", () => {
  const config = makeConfig({
    actions: [makeAction({ type: "mouseAction", payload: { action: "mouseBack" } })],
    bindings: [{ id: "b1", profileId: "p2", layer: "hypershift", controlId: "v3_thumb_01", actionId: "a1", enabled: true, label: "Find this" }],
  });
  config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "V3", builtin: true });
  config.physicalControls.push({ ...config.physicalControls[1], id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID });
  const props = show(config);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Find this" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("profile.searchAllProfiles") }));
  fireEvent.click(screen.getByRole("button", { name: /Gaming.*Find this/ }));
  expect(props.onSelectDevice).toHaveBeenCalledWith(NAGA_V3_DEVICE_ID);
  expect(props.setSelectedProfileId).toHaveBeenCalledWith("p2");
  expect(props.onSelectLayer).toHaveBeenCalledWith("hypershift");
  expect(props.setSelectedControlId).toHaveBeenCalledWith("v3_thumb_01");
  expect(vi.mocked(props.onSelectDevice).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props.setSelectedControlId).mock.invocationCallOrder[0]);
});

it.each(["thumb_02", "v3_thumb_02"])("keeps the final search selection on %s with the App fallback effect", (controlId) => {
  const config = makeConfig({
    actions: [makeAction({ type: "mouseAction", payload: { action: "mouseBack" } })],
    bindings: [{ id: "b1", profileId: "p2", layer: "hypershift", controlId, actionId: "a1", enabled: true, label: "Find this" }],
  });
  const v2 = config.devices[0].id;
  config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "V3", builtin: true });
  for (const [id, deviceId] of [["thumb_02", v2], ["v3_thumb_01", NAGA_V3_DEVICE_ID], ["v3_thumb_02", NAGA_V3_DEVICE_ID]]) {
    config.physicalControls.push({ ...config.physicalControls[1], id, deviceId });
  }
  const props = workspaceProps(config);
  function Parent() {
    const [activeDeviceId, setActiveDeviceId] = useState(v2);
    const [selectedControlId, setSelectedControlId] = useState<string | null>("thumb_01");
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>("p1");
    const [selectedLayer, setSelectedLayer] = useState<Layer>("standard");
    const [multiSelectedControlIds, setMultiSelectedControlIds] = useState(new Set(["thumb_01"]));
    // Match App's device-selection reset and fallback effect, including update priorities.
    useEffect(() => {
      if (selectedControlId === null || !config.physicalControls.some((control) =>
        control.id === selectedControlId && control.deviceId === activeDeviceId)) {
        startTransition(() => setSelectedControlId(resolveInitialControlId(config, activeDeviceId)));
      }
    }, [selectedControlId, activeDeviceId]);
    return <>
      <output data-testid="selection">{JSON.stringify({ activeDeviceId, selectedControlId, selectedProfileId, selectedLayer, multi: [...multiSelectedControlIds] })}</output>
      <ProfilesWorkspace {...props} activeDeviceId={activeDeviceId}
        activeProfile={config.profiles.find((profile) => profile.id === selectedProfileId)!}
        effectiveProfileId={selectedProfileId!} selectedLayer={selectedLayer}
        multiSelectedControlIds={multiSelectedControlIds} setMultiSelectedControlIds={setMultiSelectedControlIds}
        onSelectDevice={(id) => {
          setActiveDeviceId(id);
          setSelectedControlId(null);
          setMultiSelectedControlIds(new Set());
        }}
        setSelectedProfileId={setSelectedProfileId} onSelectLayer={setSelectedLayer}
        setSelectedControlId={setSelectedControlId} />
    </>;
  }
  render(<Parent />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Find this" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("profile.searchAllProfiles") }));
  fireEvent.click(screen.getByRole("button", { name: /Gaming.*Find this/ }));
  expect(JSON.parse(screen.getByTestId("selection").textContent!)).toEqual({
    activeDeviceId: controlId === "thumb_02" ? v2 : NAGA_V3_DEVICE_ID,
    selectedControlId: controlId, selectedProfileId: "p2", selectedLayer: "hypershift", multi: [],
  });
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("");
});

it("opens a foreign profile's rule menu and reorders within its owning profile", () => {
  const foreign = { ...rule, profileId: "p2" };
  const neighbor = { ...foreign, id: "r2", exe: "neighbor.exe", priority: 0 };
  const config = makeConfig({ appMappings: [foreign, neighbor, { ...rule, id: "other", exe: "other.exe" }] });
  const props = show(config, { allProfilesView: true });
  fireEvent.contextMenu(screen.getByText("python").closest("button")!);
  expect(screen.getByRole("menuitem", { name: "Edit" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: i18n.t("profile.moveUp") }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("profile.moveDown") }));
  const result = vi.mocked(props.updateDraft).mock.calls[0][0](config);
  expect(result.appMappings.find((mapping) => mapping.id === "r2")!.priority).toBeGreaterThan(result.appMappings.find((mapping) => mapping.id === "r1")!.priority);
  expect(result.appMappings.find((mapping) => mapping.id === "other")).toEqual(config.appMappings[2]);
});

it("keeps a foreign duplicate in its owning profile and selects that profile for editing", () => {
  const foreign = { ...rule, profileId: "p2" };
  const config = makeConfig({ appMappings: [foreign] });
  const props = show(config, { allProfilesView: true });
  fireEvent.contextMenu(screen.getByText("python").closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  const result = vi.mocked(props.updateDraft).mock.calls[0][0](config);
  expect(result.appMappings[1]).toEqual({ ...foreign, id: expect.any(String) });
  expect(props.setSelectedProfileId).toHaveBeenCalledWith("p2");
});

it("selects a foreign rule's owning profile when opening its editor", () => {
  const config = makeConfig({ appMappings: [{ ...rule, profileId: "p2" }] });
  const props = show(config, { allProfilesView: true });
  fireEvent.contextMenu(screen.getByText("python").closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(props.setSelectedProfileId).toHaveBeenCalledWith("p2");
});

function withUserDevice() {
  const config = makeConfig();
  config.devices.push({ id: "pad", name: "Pad", builtin: false });
  config.physicalControls.push({ ...config.physicalControls[0], id: "pad_1", deviceId: "pad", defaultName: "Key 1" });
  return config;
}

it("offers a user device's rename, photo and delete in its card menu, a built-in mouse its tabs", () => {
  const config = withUserDevice();
  const props = show(config, { activeDeviceId: "pad" });
  fireEvent.click(screen.getByRole("button", { name: "device card menu" }));
  expect(screen.getByRole("menuitem", { name: i18n.t("device.rename") })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: i18n.t("device.addPhoto") })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("device.delete") }));
  expect(props.setConfirmModal).toHaveBeenCalledWith(expect.objectContaining({ title: i18n.t("device.deleteTitle") }));
  cleanup();

  show(config);
  fireEvent.click(screen.getByRole("button", { name: "device card menu" }));
  expect((screen.getByRole("menuitem", { name: i18n.t("device.tabButtons") }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("device.tabStats") }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: i18n.t("device.tabStats"), pressed: true })).toBeTruthy();
});

it("a user device's button menu also edits and deletes the button itself", () => {
  const config = withUserDevice();
  const control = config.physicalControls.find((entry) => entry.id === "pad_1")!;
  const props = show(config, {
    activeDeviceId: "pad",
    familySections: [{ family: control.family, entries: [{ control, binding: null, action: null, mapping: null, isSelected: false }] }] as unknown as ProfilesWorkspaceProps["familySections"],
  });
  fireEvent.contextMenu(screen.getByText(/Key 1/).closest("button")!);
  expect(screen.getByRole("menuitem", { name: i18n.t("device.editControlTitle") })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("device.deleteControl") }));
  expect(props.setConfirmModal).toHaveBeenCalledWith(expect.objectContaining({ title: i18n.t("device.deleteControlTitle") }));
});
