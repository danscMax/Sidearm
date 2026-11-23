import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { startTransition, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { type AppConfig, type AppMapping, type Layer, type OfflineLayer } from "../lib/config";
import { setOfflineAssignment } from "../lib/config-editing";
import type { OfflinePreview } from "../lib/onboard-mapping";
import { withOfflineAssignment, type MouseVisualizationProps } from "../lib/mouse-visual";
import { NAGA_V3_DEVICE_ID } from "../lib/devices";
import { resolveInitialControlId } from "../lib/helpers";
import { offlineTargetLabel } from "../lib/labels";
import { makeAction, makeConfig } from "../lib/test-fixtures";
import { ProfilesWorkspace, type ProfilesWorkspaceProps } from "./ProfilesWorkspace";

vi.mock("./DeviceCards", () => ({
  DeviceCards: ({ onContextMenu }: { onContextMenu?: (x: number, y: number) => void }) =>
    <button type="button" onClick={() => onContextMenu?.(0, 0)}>device card menu</button>,
}));
vi.mock("./MouseVisualization", () => ({
  MouseVisualization: ({ entries, onContextMenu }: MouseVisualizationProps) => <>{entries.map((entry) => (
    <button key={entry.control.id} type="button" onContextMenu={(event) => onContextMenu?.(entry.control.id, entry.binding, entry.action, event.clientX, event.clientY)}>cell {entry.control.id}</button>
  ))}</>,
}));
vi.mock("./ExeIcon", () => ({ ExeIcon: () => null }));
vi.mock("./AppMappingModal", () => ({ AppMappingModal: () => null }));
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

function workspaceProps(config: AppConfig, extra: Partial<ProfilesWorkspaceProps> = {}) {
  const props: ProfilesWorkspaceProps = {
    offlinePreview: { target: { state: "written" }, controls: [] },
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

function offlineProps(config: AppConfig, layer: OfflineLayer = "offline"): Partial<ProfilesWorkspaceProps> {
  const control = config.physicalControls[1];
  const offlinePreview: OfflinePreview = { target: { state: "written" }, controls: [{ controlId: control.id, layer, kind: "preserved", editable: true }] };
  return {
    offlinePreview,
    selectedLayer: layer,
    familySections: [{ family: control.family, entries: [withOfflineAssignment(config, "p1", layer, { control, action: null, binding: null, mapping: null, isSelected: false }, offlinePreview)] }],
  };
}

it.each<OfflineLayer>(["offline", "offlineHypershift"])("silences an offline cell on %s without changing live bindings", (layer) => {
  const config = makeConfig();
  const props = show(config, offlineProps(config, layer));
  fireEvent.contextMenu(screen.getByRole("button", { name: "cell thumb_01" }));
  expect(screen.getByRole<HTMLButtonElement>("menuitem", { name: i18n.t("offline.inherit") }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("offline.mute") }));
  const result = vi.mocked(props.updateDraft).mock.calls[0][0](config);
  expect(result.actions[0].type).toBe("disabled");
  expect(result.bindings).toEqual([expect.objectContaining({ layer, enabled: true, controlId: "thumb_01" })]);
});

it.each(["silent", "own"] as const)("restores inheritance from an %s override", (kind) => {
  const config = setOfflineAssignment(makeConfig(), "p1", "thumb_01", "offline", kind === "silent" ? "silent" : { action: "middleClick" });
  const props = show(config, offlineProps(config));
  fireEvent.contextMenu(screen.getByRole("button", { name: "cell thumb_01" }));
  expect(screen.getByRole<HTMLButtonElement>("menuitem", { name: i18n.t("offline.inherit") }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("offline.inherit") }));
  const result = vi.mocked(props.updateDraft).mock.calls[0][0](config);
  expect(result.bindings).toEqual([]);
  expect(result.actions).toEqual([]);
});

it("opens the offline cell's existing picker path without selecting an inherited live binding", () => {
  const config = makeConfig({
    actions: [makeAction({ type: "mouseAction", payload: { action: "middleClick" } })],
    bindings: [{ id: "live", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: "a1", enabled: true, label: "Middle" }],
  });
  const props = show(config, offlineProps(config));
  fireEvent.contextMenu(screen.getByRole("button", { name: "cell thumb_01" }));
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("offline.edit") }));
  expect(props.setSelectedControlId).toHaveBeenCalledWith("thumb_01");
  expect(props.setActionPickerBindingId).toHaveBeenCalledWith(null);
  expect(props.setActionPickerOpen).toHaveBeenCalledWith(true);
  expect(props.updateDraft).not.toHaveBeenCalled();
});

it("shows the exit target and a Mouse memory link, and hides heatmap tools", () => {
  const config = makeConfig();
  show(config, offlineProps(config));
  expect(screen.getByText(i18n.t("offline.written"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: i18n.t("profile.heatmapOff") })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: i18n.t("device.tabMemory") }).at(-1)!);
  expect(screen.getByRole("button", { name: i18n.t("device.tabMemory"), pressed: true })).toBeTruthy();
});

it.each([
  [{ state: "notWritten" }, "warning"],
  [{ state: "unknown" }, "warning"],
  [{ state: "written", bank: 3 }, "info"],
  [{ state: "followsWindow" }, "info"],
] satisfies [OfflinePreview["target"], string][])("uses the planner target %j in a canonical notice", (target, variant) => {
  const config = makeConfig();
  show(config, { ...offlineProps(config), offlinePreview: { target, controls: [] } });
  const notice = screen.getByText(offlineTargetLabel(target, config, "p1")).closest(".notice")!;
  expect(notice.classList.contains(`notice--${variant}`)).toBe(true);
  if ("bank" in target) expect(notice.textContent).toContain(i18n.t("offline.writtenBank", { bank: 3 }));
});

it.each(["en", "ru"])('explains the actual exit target and fix in %s', async (language) => {
  await i18n.changeLanguage(language);
  const config = makeConfig();
  const targets: [OfflinePreview["target"], string[]][] = [
    [{ state: "notWritten", writtenProfileId: "p2" }, [i18n.t("offline.notWritten", { name: "Gaming" })]],
    [{ state: "notWritten", banks: [{ bank: 1, profileId: "p2" }] }, [i18n.t("offline.notWrittenBanks", { name: "Default", banks: "1: Gaming" })]],
    [{ state: "written", bank: 2, banks: [{ bank: 1, profileId: "p2" }, { bank: 2, profileId: "p1" }] },
      [i18n.t("offline.writtenBank", { bank: 2 }), i18n.t("offline.bankPlan", { banks: "1: Gaming, 2: Default" })]],
    // The mouse plays another bank after the exit: say so, and how this one plays.
    [{ state: "written", bank: 2, playingBank: 1, banks: [{ bank: 1, profileId: "p2" }, { bank: 2, profileId: "p1" }] },
      [i18n.t("offline.writtenBank", { bank: 2 }), i18n.t("offline.playsOther", { bank: 1, name: "Gaming" })]],
    [{ state: "written", bank: 2, playingBank: 2, banks: [{ bank: 2, profileId: "p1" }] }, [i18n.t("offline.playsThis")]],
    [{ state: "followsWindow" }, [i18n.t("offline.followsWindow")]],
    [{ state: "unknown" }, [i18n.t("offline.unknown")]],
  ];
  for (const [target, texts] of targets) {
    const view = render(<ProfilesWorkspace {...workspaceProps(config, { ...offlineProps(config), offlinePreview: { target, controls: [] } })} />);
    const notice = view.container.querySelector(".notice")!;
    for (const text of texts) expect(notice.textContent).toContain(text);
    expect(within(notice as HTMLElement).getByRole("button", { name: i18n.t("device.tabMemory") })).toBeTruthy();
    view.unmount();
  }
});

it.each(["role", "unavailable"] as const)("refuses edits/mute for %s but allows removing an ineffective own binding", (kind) => {
  const config = setOfflineAssignment(makeConfig(), "p1", "thumb_01", "offline", "silent");
  const props = show(config, { ...offlineProps(config), offlinePreview: {
    target: { state: "written" }, controls: [{ controlId: "thumb_01", layer: "offline", kind, editable: false }],
  } });
  fireEvent.contextMenu(screen.getByRole("button", { name: "cell thumb_01" }));
  for (const key of ["mute", "edit"]) {
    const item = screen.getByRole<HTMLButtonElement>("menuitem", { name: i18n.t(`offline.${key}`) });
    expect(item.disabled).toBe(true);
    fireEvent.click(item);
  }
  expect(props.updateDraft).not.toHaveBeenCalled();
  expect(props.setActionPickerOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("offline.inherit") }));
  expect(vi.mocked(props.updateDraft).mock.calls[0][0](config).bindings).toEqual([]);
});

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

it.each<OfflineLayer>(["offline", "offlineHypershift"])("excludes %s bindings from cross-profile search and its other-profile count", (layer) => {
  const config = makeConfig({
    actions: [makeAction({ type: "mouseAction", payload: { action: "rightClick" } })],
    bindings: [
      { id: "live", profileId: "p2", layer: "standard", controlId: "thumb_01", actionId: "a1", enabled: true, label: "Search match live" },
      { id: "firmware", profileId: "p2", layer, controlId: "thumb_01", actionId: "a1", enabled: true, label: "Search match firmware" },
      { id: "local-firmware", profileId: "p1", layer, controlId: "thumb_01", actionId: "a1", enabled: true, label: "Search match local firmware" },
    ],
  });
  show(config);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Search match" } });
  expect(screen.getByRole("button", { name: i18n.t("profile.searchFoundElsewhere", { count: 1 }) })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("profile.searchAllProfiles") }));
  expect(screen.getByRole("button", { name: /Gaming.*Search match live/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Search match.*firmware/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "firmware" } });
  expect(screen.getByText(i18n.t("profile.searchNoResults"))).toBeTruthy();
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
