import type {
  Action,
  AppConfig,
  PhysicalControl,
  SnippetLibraryItem,
} from "./config";

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
    physicalControls: [
      {
        id: "mouse_4",
        family: "topPanel",
        defaultName: "Mouse 4",
        remappable: true,
        capabilityStatus: "verified",
      },
      {
        id: "thumb_01",
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
    pretty: "Test Action",
    ...overrides,
  } as Action;
}

export function makeSnippetMap(items: SnippetLibraryItem[]): Map<string, SnippetLibraryItem> {
  return new Map(items.map((s) => [s.id, s]));
}

export const emptySnippets = new Map<string, SnippetLibraryItem>();
