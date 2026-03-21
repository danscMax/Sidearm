import * as fc from "fast-check";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type {
  Action,
  AppConfig,
  AppMapping,
  Binding,
  ControlId,
  Layer,
  Profile,
} from "./config";
import {
  createAppMappingFromCapture,
  extractProfileForExport,
  importProfile,
} from "./config-editing";
import { parseCommaSeparatedUniqueValues } from "./helpers";

// Mock @tauri-apps/plugin-log for useLogPanel tests
vi.mock("@tauri-apps/plugin-log", () => ({
  attachLogger: vi.fn(() => Promise.resolve(() => {})),
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CONTROL_IDS: ControlId[] = [
  "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
  "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
  "mouse_left", "mouse_right", "top_aux_01", "top_aux_02",
  "mouse_4", "mouse_5", "wheel_up", "wheel_down", "wheel_click",
  "wheel_left", "wheel_right", "hypershift_button",
  "top_special_01", "top_special_02", "top_special_03",
];

const ALL_LAYERS: Layer[] = ["standard", "hypershift"];

function createMinimalConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    version: 1,
    settings: {
      fallbackProfileId: "",
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
    profiles: [],
    physicalControls: [],
    encoderMappings: [],
    appMappings: [],
    bindings: [],
    actions: [],
    snippetLibrary: [],
    ...overrides,
  };
}

// Arbitrary for an existing set of app mappings with unique IDs (realistic input)
const arbExistingAppMappings: fc.Arbitrary<AppMapping[]> = fc
  .uniqueArray(
    fc.string({ minLength: 3, maxLength: 20 }).map(
      (s) => `app-${s.replace(/[^a-z0-9-]/g, "x")}`,
    ),
    { minLength: 0, maxLength: 10 },
  )
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          exe: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.toLowerCase()),
          profileId: fc.constant("profile-default"),
          enabled: fc.boolean(),
          priority: fc.integer({ min: 0, max: 100 }),
        }),
      ),
    ),
  ) as fc.Arbitrary<AppMapping[]>;

// ---------------------------------------------------------------------------
// 1. createAppMappingFromCapture
// ---------------------------------------------------------------------------

describe("createAppMappingFromCapture (PBT)", () => {
  it("result mapping ID is always unique in resulting config", () => {
    fc.assert(
      fc.property(
        arbExistingAppMappings,
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.integer({ min: 0, max: 9999 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.boolean(),
        (existingMappings, exe, priority, title, includeTitleFilter) => {
          const config = createMinimalConfig({
            appMappings: existingMappings,
            profiles: [{ id: "profile-default", name: "Default", enabled: true, priority: 0 }],
          });
          const result = createAppMappingFromCapture(
            config, "profile-default", priority, exe, title, includeTitleFilter,
          );
          const allIds = result.config.appMappings.map((m) => m.id);
          const uniqueIds = new Set(allIds);
          expect(uniqueIds.size).toBe(allIds.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("exe is normalized to lowercase", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        fc.integer({ min: 0, max: 9999 }),
        (exe, priority) => {
          const config = createMinimalConfig({
            profiles: [{ id: "p1", name: "P1", enabled: true, priority: 0 }],
          });
          const result = createAppMappingFromCapture(config, "p1", priority, exe, "", false);
          const newMapping = result.config.appMappings.find((m) => m.id === result.newMappingId);
          expect(newMapping).toBeDefined();
          expect(newMapping!.exe).toBe(newMapping!.exe.toLowerCase());
        },
      ),
      { numRuns: 500 },
    );
  });

  it("exe is trimmed (no leading/trailing whitespace)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        fc.integer({ min: 0, max: 100 }),
        (exe, priority) => {
          const config = createMinimalConfig({
            profiles: [{ id: "p1", name: "P1", enabled: true, priority: 0 }],
          });
          const result = createAppMappingFromCapture(config, "p1", priority, exe, "", false);
          const newMapping = result.config.appMappings.find((m) => m.id === result.newMappingId);
          expect(newMapping).toBeDefined();
          expect(newMapping!.exe).toBe(newMapping!.exe.trim());
        },
      ),
      { numRuns: 500 },
    );
  });

  it("empty exe throws error", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "  ", "\t", "\n"),
        (exe) => {
          const config = createMinimalConfig({
            profiles: [{ id: "p1", name: "P1", enabled: true, priority: 0 }],
          });
          expect(() => createAppMappingFromCapture(config, "p1", 0, exe, "", false)).toThrow();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("priority is clamped to 0-9999 range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 20000 }),
        (priority) => {
          const config = createMinimalConfig({
            profiles: [{ id: "p1", name: "P1", enabled: true, priority: 0 }],
          });
          const result = createAppMappingFromCapture(config, "p1", priority, "test.exe", "", false);
          const mapping = result.config.appMappings.find((m) => m.id === result.newMappingId);
          expect(mapping!.priority).toBeGreaterThanOrEqual(0);
          expect(mapping!.priority).toBeLessThanOrEqual(9999);
        },
      ),
      { numRuns: 500 },
    );
  });

});

// ---------------------------------------------------------------------------
// 2. extractProfileForExport / importProfile roundtrip
// ---------------------------------------------------------------------------

describe("extractProfileForExport / importProfile roundtrip (PBT)", () => {
  // Build a config with a profile, bindings, and actions for roundtrip testing
  const arbConfigWithProfile = fc.record({
    profileName: fc.string({ minLength: 1, maxLength: 30 }),
    bindingCount: fc.integer({ min: 1, max: 12 }),
  }).chain(({ profileName, bindingCount }) => {
    const profileId = `profile-${profileName.replace(/[^a-z0-9]/gi, "x").toLowerCase() || "p"}`;

    // Create N unique actions
    const actions: Action[] = [];
    for (let i = 0; i < bindingCount; i++) {
      actions.push({
        id: `action-${profileId}-${i}`,
        type: "disabled",
        payload: {} as Record<string, never>,
        pretty: `Action ${i}`,
      });
    }

    // Create N bindings, cycling through controls and layers to avoid collisions
    const bindings: Binding[] = [];
    for (let i = 0; i < bindingCount; i++) {
      const controlId = ALL_CONTROL_IDS[i % ALL_CONTROL_IDS.length];
      const layer = ALL_LAYERS[Math.floor(i / ALL_CONTROL_IDS.length) % 2];
      bindings.push({
        id: `binding-${profileId}-${layer}-${controlId}`,
        profileId,
        layer,
        controlId,
        label: `Binding ${i}`,
        actionRef: actions[i].id,
        enabled: true,
      });
    }

    const profile: Profile = {
      id: profileId,
      name: profileName,
      enabled: true,
      priority: 10,
    };

    return fc.record({
      appMappingCount: fc.integer({ min: 0, max: 3 }),
    }).map(({ appMappingCount }) => {
      const appMappings: AppMapping[] = [];
      for (let i = 0; i < appMappingCount; i++) {
        appMappings.push({
          id: `app-${profileId}-${i}`,
          exe: `app${i}.exe`,
          profileId,
          enabled: true,
          priority: i,
        });
      }

      const config = createMinimalConfig({
        profiles: [profile],
        actions,
        bindings,
        appMappings,
        encoderMappings: [],
      });

      return { config, profileId };
    });
  });

  it("action count is preserved through export/import roundtrip", () => {
    fc.assert(
      fc.property(arbConfigWithProfile, ({ config, profileId }) => {
        const exported = extractProfileForExport(config, profileId);
        expect(exported).not.toBeNull();
        if (!exported) return;

        const originalActionCount = exported.actions.length;

        // Import into an empty config (no collisions)
        const emptyConfig = createMinimalConfig();
        const imported = importProfile(emptyConfig, exported);

        // Count actions belonging to the newly imported profile
        const importedProfile = imported.profiles[0];
        expect(importedProfile).toBeDefined();

        const importedBindings = imported.bindings.filter(
          (b) => b.profileId === importedProfile.id,
        );
        const importedActionRefs = new Set(importedBindings.map((b) => b.actionRef));
        const importedActions = imported.actions.filter((a) => importedActionRefs.has(a.id));

        expect(importedActions.length).toBe(originalActionCount);
      }),
      { numRuns: 500 },
    );
  });

  it("binding count is preserved through export/import roundtrip", () => {
    fc.assert(
      fc.property(arbConfigWithProfile, ({ config, profileId }) => {
        const exported = extractProfileForExport(config, profileId);
        expect(exported).not.toBeNull();
        if (!exported) return;

        const originalBindingCount = exported.bindings.length;
        const emptyConfig = createMinimalConfig();
        const imported = importProfile(emptyConfig, exported);
        const importedProfile = imported.profiles[0];
        const importedBindings = imported.bindings.filter(
          (b) => b.profileId === importedProfile.id,
        );

        expect(importedBindings.length).toBe(originalBindingCount);
      }),
      { numRuns: 500 },
    );
  });

  it("import never creates duplicate IDs across config", () => {
    fc.assert(
      fc.property(arbConfigWithProfile, ({ config, profileId }) => {
        const exported = extractProfileForExport(config, profileId);
        expect(exported).not.toBeNull();
        if (!exported) return;

        // Import into the SAME config (forces ID collisions)
        const imported = importProfile(config, exported);

        // Check all entity ID sets for uniqueness
        const profileIds = imported.profiles.map((p) => p.id);
        expect(new Set(profileIds).size).toBe(profileIds.length);

        const bindingIds = imported.bindings.map((b) => b.id);
        expect(new Set(bindingIds).size).toBe(bindingIds.length);

        const actionIds = imported.actions.map((a) => a.id);
        expect(new Set(actionIds).size).toBe(actionIds.length);

        const appMappingIds = imported.appMappings.map((m) => m.id);
        expect(new Set(appMappingIds).size).toBe(appMappingIds.length);
      }),
      { numRuns: 500 },
    );
  });

  it("import preserves all control-layer pairs from bindings", () => {
    fc.assert(
      fc.property(arbConfigWithProfile, ({ config, profileId }) => {
        const exported = extractProfileForExport(config, profileId);
        if (!exported) return;

        const emptyConfig = createMinimalConfig();
        const imported = importProfile(emptyConfig, exported);
        const importedProfile = imported.profiles[0];

        const originalPairs = new Set(
          exported.bindings.map((b) => `${b.layer}:${b.controlId}`),
        );
        const importedPairs = new Set(
          imported.bindings
            .filter((b) => b.profileId === importedProfile.id)
            .map((b) => `${b.layer}:${b.controlId}`),
        );

        expect(importedPairs).toEqual(originalPairs);
      }),
      { numRuns: 500 },
    );
  });

  it("imported bindings all have valid actionRef pointing to existing actions", () => {
    fc.assert(
      fc.property(arbConfigWithProfile, ({ config, profileId }) => {
        const exported = extractProfileForExport(config, profileId);
        if (!exported) return;

        const imported = importProfile(config, exported);
        const actionIds = new Set(imported.actions.map((a) => a.id));

        for (const binding of imported.bindings) {
          expect(actionIds.has(binding.actionRef)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. parseCommaSeparatedUniqueValues
// ---------------------------------------------------------------------------

describe("parseCommaSeparatedUniqueValues (PBT)", () => {
  it("idempotent: parse(parse(x).join(', ')) equals parse(x)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const first = parseCommaSeparatedUniqueValues(input);
        const rejoined = first.join(", ");
        const second = parseCommaSeparatedUniqueValues(rejoined);
        expect(second).toEqual(first);
      }),
      { numRuns: 500 },
    );
  });

  it("result never contains empty strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedUniqueValues(input);
        for (const value of result) {
          expect(value).not.toBe("");
        }
      }),
      { numRuns: 500 },
    );
  });

  it("result never contains duplicates", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedUniqueValues(input);
        expect(new Set(result).size).toBe(result.length);
      }),
      { numRuns: 500 },
    );
  });

  it("all values in result are trimmed", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedUniqueValues(input);
        for (const value of result) {
          expect(value).toBe(value.trim());
        }
      }),
      { numRuns: 500 },
    );
  });

  it("result length is at most the number of comma-separated segments", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedUniqueValues(input);
        const segments = input.split(",").length;
        expect(result.length).toBeLessThanOrEqual(segments);
      }),
      { numRuns: 500 },
    );
  });

  it("order is preserved (first occurrence wins)", () => {
    // Use strings without commas since commas are the delimiter
    const arbSegment = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !s.includes(","));

    fc.assert(
      fc.property(
        fc.array(arbSegment, { minLength: 1, maxLength: 20 }),
        (values) => {
          const input = values.join(",");
          const result = parseCommaSeparatedUniqueValues(input);
          // Every element in result should appear in the original order
          // relative to their first occurrence
          const trimmedValues = values.map((v) => v.trim()).filter(Boolean);
          const expectedOrder: string[] = [];
          const seen = new Set<string>();
          for (const v of trimmedValues) {
            if (!seen.has(v)) {
              seen.add(v);
              expectedOrder.push(v);
            }
          }
          expect(result).toEqual(expectedOrder);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. useLogPanel ring buffer
// ---------------------------------------------------------------------------

describe("useLogPanel ring buffer (PBT)", () => {
  // We dynamically import to use the lazy mock setup
  it("after N ingestions (N > 1000), log count is always <= 1000", async () => {
    const { useLogPanel } = await import("../hooks/useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 3000 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          expect(result.current.logs.length).toBeLessThanOrEqual(1000);
        },
      ),
      { numRuns: 50 }, // Lower runs: each iteration renders a hook with 1000+ ingestions
    );
  });

  it("first log after overflow has the correct sequential ID", async () => {
    const { useLogPanel } = await import("../hooks/useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 2000 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          const logs = result.current.logs;
          // The ring buffer slices from (length - 1000), so the first
          // retained log should have an ID equal to (totalIngestions - 1000 + 1)
          // because IDs start at 1 and increment sequentially.
          // However, the hook uses a ref that persists within the same
          // renderHook instance, so the first log's ID = totalIngestions - 999.
          expect(logs.length).toBe(1000);
          expect(logs[0].id).toBe(totalIngestions - 999);
          expect(logs[logs.length - 1].id).toBe(totalIngestions);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("log IDs are strictly monotonically increasing after overflow", async () => {
    const { useLogPanel } = await import("../hooks/useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 2500 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          const logs = result.current.logs;
          for (let i = 1; i < logs.length; i++) {
            expect(logs[i].id).toBeGreaterThan(logs[i - 1].id);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("exact buffer size (1000) does not trigger truncation", async () => {
    const { useLogPanel } = await import("../hooks/useLogPanel");

    const { result } = renderHook(() => useLogPanel());

    act(() => {
      for (let i = 0; i < 1000; i++) {
        result.current._ingestForTest({ level: 3, message: `msg-${i}` });
      }
    });

    expect(result.current.logs.length).toBe(1000);
    expect(result.current.logs[0].id).toBe(1);
    expect(result.current.logs[999].id).toBe(1000);
  });
});
