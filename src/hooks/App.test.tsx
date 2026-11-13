import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backend")>();
  return {
    ...actual,
    ...Object.fromEntries(Object.keys(actual).filter((key) => key.startsWith("listen"))
      .map((key) => [key, vi.fn().mockResolvedValue(vi.fn())])),
    loadConfig: vi.fn(),
    saveConfig: vi.fn(async (config) => ({ config, warnings: [], path: "config.json" })),
    setNativeTexts: vi.fn().mockResolvedValue(undefined),
    getAppPaths: vi.fn().mockResolvedValue({ testRun: true }),
    getAdminAutostartStatus: vi.fn().mockResolvedValue({ enabled: false }),
    getMouseStatus: vi.fn().mockResolvedValue([]),
    getNativeModel: vi.fn().mockResolvedValue({ consumerSignals: true }),
    getDebugLog: vi.fn().mockResolvedValue([]),
    startRuntime: vi.fn().mockResolvedValue({ status: "idle" }),
    listBundledPresets: vi.fn().mockResolvedValue([]),
  };
});
vi.mock("@tauri-apps/plugin-log", () => ({ attachLogger: vi.fn().mockResolvedValue(vi.fn()), error: vi.fn() }));
vi.mock("../components/ProfilesWorkspace", () => ({ ProfilesWorkspace: vi.fn(() => null) }));
vi.mock("../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("../components/SynapseNotice", () => ({ SynapseNotice: () => null }));
vi.mock("../components/NewMouseNotice", () => ({ NewMouseNotice: () => null }));

import App from "../App";
import i18n from "../i18n";
import * as backend from "../lib/backend";
import { makeConfig } from "../lib/test-fixtures";
import { ProfilesWorkspace } from "../components/ProfilesWorkspace";

const config = makeConfig({
  settings: { ...makeConfig().settings, onboardingCompleted: true },
  bindings: [{ id: "b1", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: "a1", label: "Test", enabled: true }],
  actions: [{ id: "a1", type: "disabled", displayName: "Disabled", payload: {} }],
});
const workspace = () => vi.mocked(ProfilesWorkspace).mock.calls.at(-1)![0];

async function renderReady() {
  await act(async () => { render(<App />); });
  expect(workspace().activeConfig).toEqual(config);
}

describe("App orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backend.loadConfig).mockResolvedValue({ config, warnings: [], path: "config.json", createdDefault: false });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    "listenDragDrop", "listenSingleInstanceBlocked", "listenMouseDefaultsSuspected",
    "listenMouseStatus", "listenMouseBattery", "listenElevatedForeground",
    "listenTrayProfileChanged", "listenQuickRuleStart", "listenQuickRuleFailed",
  ] as const)("releases a late %s registration after unmount", async (name) => {
    let attach!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    vi.mocked(backend[name]).mockImplementationOnce(() => new Promise((resolve) => { attach = resolve; }));
    await renderReady();
    cleanup();
    await act(async () => { attach(unlisten); });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("removes a deferred mouse-status visibility callback on unmount", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await renderReady();
    cleanup();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(backend.getMouseStatus).not.toHaveBeenCalled();
  });

  it("ignores a mouse-status snapshot that arrives after unmount", async () => {
    let resolveStatus!: (events: Awaited<ReturnType<typeof backend.getMouseStatus>>) => void;
    vi.mocked(backend.getMouseStatus).mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    await renderReady();
    cleanup();
    await act(async () => { resolveStatus([{ kind: "signalsSwitched", active: true }]); });
    expect(backend.getNativeModel).not.toHaveBeenCalled();
  });

  it.each([{ key: "Delete" }, { key: "Backspace" }, { key: "z", ctrlKey: true }])(
    "keeps the workspace unchanged behind presets for $key", async (key) => {
      await renderReady();
      act(() => {
        workspace().updateDraft((current) => ({
          ...current, profiles: current.profiles.map((profile) => ({ ...profile, name: "Edited" })),
        }));
      });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.click(screen.getByText(i18n.t("command.presets")));
      await act(async () => {});
      const before = workspace().activeConfig;
      fireEvent.keyDown(screen.getByRole("dialog"), key);
      expect(workspace().activeConfig).toBe(before);
    },
  );

  it("reapplies an edit through the saved Undo-toast action", async () => {
    await renderReady();
    act(() => {
      workspace().updateDraft((current) => ({
        ...current, profiles: current.profiles.map((profile) => ({ ...profile, name: "Edited" })),
      }));
    });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(workspace().activeConfig.profiles[0].name).toBe("Default");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("toast.undoAction") }));
    expect(workspace().activeConfig.profiles[0].name).toBe("Edited");
  });
});
