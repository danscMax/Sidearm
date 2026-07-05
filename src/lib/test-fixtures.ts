import type {
  Action,
  AppConfig,
  Device,
  PhysicalControl,
  SnippetLibraryItem,
} from "./config";
import { RAZER_NAGA_DEVICE_ID } from "./config";

/** The built-in Naga device every legacy fixture hangs its controls on. */
const NAGA_DEVICE: Device = {
  id: RAZER_NAGA_DEVICE_ID,
  name: "Razer Naga V2 Hyperspeed",
  builtin: true,
};

// ---------------------------------------------------------------------------
// Helpers to build minimal fixtures
// ---------------------------------------------------------------------------

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    settings: {
      fallbackProfileId: "p1",
      theme: "dark",
      startWithWindows: false,
      minimizeToTray: false,
      debugLogging: false,
      osdEnabled: true,
      osdDurationMs: 2000,
      osdPosition: "bottomRight",
      osdFontSize: "medium",
      osdAnimation: "slideIn",
    },
    profiles: [
      { id: "p1", name: "Default", enabled: true, priority: 0 },
      { id: "p2", name: "Gaming", enabled: true, priority: 1 },
    ],
    devices: [NAGA_DEVICE],
    physicalControls: [
      {
        id: "mouse_4",
        deviceId: RAZER_NAGA_DEVICE_ID,
        family: "topPanel",
        defaultName: "Mouse 4",
        remappable: true,
        capabilityStatus: "verified",
      },
      {
        id: "thumb_01",
        deviceId: RAZER_NAGA_DEVICE_ID,
        family: "thumbGrid",
        defaultName: "Thumb 1",
        remappable: true,
        capabilityStatus: "verified",
      },
    ] as PhysicalControl[],
    encoderMappings: [],
    appMappings: [],
    bindings: [],
    actions: [],
    snippetLibrary: [],
    ...overrides,
  };
}

export function makeAction(overrides: Partial<Action> & Pick<Action, "type" | "payload">): Action {
  return {
    id: "a1",
    displayName: "Test Action",
    ...overrides,
  } as Action;
}

export function makeSnippetMap(items: SnippetLibraryItem[]): Map<string, SnippetLibraryItem> {
  return new Map(items.map((s) => [s.id, s]));
}

export const emptySnippets = new Map<string, SnippetLibraryItem>();
