import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { AppConfig, AppMapping } from "../lib/config";
import { NAGA_V3_DEVICE_ID } from "../lib/devices";
import { makeAction, makeConfig } from "../lib/test-fixtures";
import { ProfilesWorkspace, type ProfilesWorkspaceProps } from "./ProfilesWorkspace";

vi.mock("./DeviceCards", () => ({ DeviceCards: () => null }));
vi.mock("./MouseVisualization", () => ({ MouseVisualization: () => null }));
vi.mock("./ExeIcon", () => ({ ExeIcon: () => null }));
vi.mock("./AppMappingModal", () => ({ AppMappingModal: () => null }));
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

function show(config: AppConfig, extra: Partial<ProfilesWorkspaceProps> = {}) {
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
