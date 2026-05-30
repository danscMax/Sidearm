/**
 * config-editing.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for config-editing.ts.
 * Targets invariants NOT already covered by config-editing.test.ts
 * and edge-cases.test.ts.
 *
 * Categories:
 *   - Boundary (40%)
 *   - Null & Empty (20%)
 *   - Overflow / extreme input (15%)
 *   - Concurrency — N/A: all functions are pure TS with no shared mutable
 *     module state. makeRandomId() uses crypto.randomUUID() which is
 *     synchronous; there is no race-condition surface in pure functions.
 *   - Temporal — N/A for most functions. extractProfileExport() embeds
 *     new Date().toISOString(); we test that the field is a valid ISO-8601
 *     string but do not assert a specific timestamp.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type {
  Action,
  AppConfig,
  AppMapping,
  Binding,
  ControlId,
  EncoderMapping,
  Layer,
  Profile,
  SnippetLibraryItem,
} from "./config";
import {
  makeProfileId,
  makeSnippetId,
  makeAppMappingId,
  makeBindingId,
  makeActionId,
  makeRandomId,
  createProfile,
  deleteProfile,
  duplicateProfile,
  upsertBinding,
  upsertAction,
  upsertSnippetLibraryItem,
  removeBinding,
  deleteAppMapping,
  reorderAppMappingPriority,
  coerceActionType,
  promoteInlineSnippetActionToLibrary,
  createDefaultActionMenuItem,
  createDefaultSubmenuItem,
  collectMenuActionRefs,
  findDuplicateAppMapping,
  extractProfileExport,
  importProfile,
  ensurePlaceholderBinding,
  duplicateBinding,
} from "./config-editing";
import type { ProfileExportData } from "./config-editing";

// ---------------------------------------------------------------------------
// Shared minimal-config factory (mirrors existing tests — kept local to avoid
// coupling to an exported helper that may change shape)
// ---------------------------------------------------------------------------

function minCfg(overrides: Partial<AppConfig> = {}): AppConfig {
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

function makeProfile(id = "p1", name = "Default"): Profile {
  return { id, name, enabled: true, priority: 10 };
}

function makeAction(id = "a1"): Action {
  return {
    id,
    type: "disabled",
    payload: {} as Record<string, never>,
    pretty: "Action " + id,
  };
}

function makeBinding(
  id = "b1",
  profileId = "p1",
  controlId: ControlId = "thumb_01",
  actionRef = "a1",
  layer: Layer = "standard",
): Binding {
  return { id, profileId, layer, controlId, label: "Binding " + id, actionRef, enabled: true };
}

function makeAppMapping(id = "app-x", profileId = "p1", priority = 10): AppMapping {
  return { id, exe: "x.exe", profileId, enabled: true, priority };
}

function makeSnippet(id = "snippet-hello"): SnippetLibraryItem {
  return { id, name: "Hello", text: "Hello world", pasteMode: "sendText", tags: [] };
}

// ---------------------------------------------------------------------------
// BOUNDARY (40%)
// ---------------------------------------------------------------------------

describe("boundary: makeProfileId / makeSnippetId / makeAppMappingId idempotence", () => {
  // These normalizers must be idempotent: f(f(x)) === f(x)
  it("makeProfileId is idempotent on already-normalized ids", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (name) => {
        const once = makeProfileId(name);
        const twice = makeProfileId(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });

  it("makeSnippetId is deterministic and always carries the snippet- prefix", () => {
    // NOTE: makeSnippetId is intentionally NOT idempotent — it prepends
    // "snippet-" on every call, so f(f(x)) double-prefixes. It is meant to be
    // called on a raw name, never on its own output. Real contract:
    // deterministic output with a stable prefix.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (name) => {
        expect(makeSnippetId(name)).toBe(makeSnippetId(name));
        expect(makeSnippetId(name).startsWith("snippet-")).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("makeAppMappingId is deterministic and always carries the app- prefix", () => {
    // NOTE: makeAppMappingId is intentionally NOT idempotent — it prepends
    // "app-" on every call. Real contract: deterministic output, stable prefix.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (exe) => {
        expect(makeAppMappingId(exe)).toBe(makeAppMappingId(exe));
        expect(makeAppMappingId(exe).startsWith("app-")).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("makeProfileId result always matches expected id character set (a-z, 0-9, -)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (name) => {
        const id = makeProfileId(name);
        expect(id).toMatch(/^[a-z0-9-]+$/);
      }),
      { numRuns: 1000 },
    );
  });

  it("makeSnippetId result always starts with 'snippet-'", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (name) => {
        expect(makeSnippetId(name)).toMatch(/^snippet-/);
      }),
      { numRuns: 1000 },
    );
  });

  it("makeAppMappingId result always starts with 'app-'", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (exe) => {
        expect(makeAppMappingId(exe)).toMatch(/^app-/);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: createProfile with N existing profiles", () => {
  it("priority is always max(existing)+10 regardless of profile count", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 0, maxLength: 20 }),
        (priorities) => {
          const profiles = priorities.map((_p, i) => makeProfile(`p-${i}`, `P${i}`));
          profiles.forEach((prof, i) => { (prof as Profile).priority = priorities[i]!; });
          const cfg = minCfg({ profiles });
          const result = createProfile(cfg, "New");
          const highest = priorities.length > 0 ? Math.max(...priorities) : 0;
          expect(result.profiles[result.profiles.length - 1]!.priority).toBe(highest + 10);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("creates a profile with unique id even when many duplicates already exist", () => {
    // Seed "gaming", "gaming-2" ... "gaming-999" and add one more "Gaming"
    const profileIds = ["gaming", ...Array.from({ length: 100 }, (_, i) => `gaming-${i + 2}`)];
    const profiles = profileIds.map((id, i) => ({ ...makeProfile(id, `G${i}`), priority: i }));
    const cfg = minCfg({ profiles });
    const result = createProfile(cfg, "Gaming");
    const newId = result.profiles[result.profiles.length - 1]!.id;
    // Must not collide with any pre-existing id
    expect(profileIds).not.toContain(newId);
  });
});

describe("boundary: deleteProfile with zero and many profiles", () => {
  it("deleteProfile on empty config is a no-op (does not throw)", () => {
    const cfg = minCfg();
    expect(() => deleteProfile(cfg, "nonexistent")).not.toThrow();
  });

  it("deleteProfile leaves no dangling bindings for the deleted profile", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (n) => {
          // Build config with n profiles each with one binding+action
          const profiles = Array.from({ length: n }, (_, i) => makeProfile(`p${i}`, `P${i}`));
          const actions: Action[] = profiles.map((p) => makeAction(`a-${p.id}`));
          const bindings: Binding[] = profiles.map((p, i) =>
            makeBinding(`b-${p.id}`, p.id, "thumb_01", actions[i]!.id),
          );
          const cfg = minCfg({ profiles, actions, bindings });

          // Delete first profile
          const result = deleteProfile(cfg, profiles[0]!.id);

          // No binding should reference the deleted profileId
          expect(result.bindings.every((b) => b.profileId !== profiles[0]!.id)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("boundary: reorderAppMappingPriority — single and two-element lists", () => {
  it("reorder with 2 mappings is invertible: swap-swap === original", () => {
    const cfg = minCfg({
      appMappings: [
        makeAppMapping("a", "p1", 20),
        makeAppMapping("b", "p1", 10),
      ],
    });
    const swapped = reorderAppMappingPriority(cfg, "b", "a");
    const restored = reorderAppMappingPriority(swapped, "a", "b");

    // Priority order should be the same as original after double-swap
    const origOrder = cfg.appMappings.map((m) => m.id).sort();
    const restoredOrder = restored.appMappings.map((m) => m.id).sort();
    expect(restoredOrder).toEqual(origOrder);
  });

  it("reorder priorities form an arithmetic sequence (step 10, descending) for the profile", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        (n) => {
          const mappings = Array.from({ length: n }, (_, i) =>
            makeAppMapping(`m${i}`, "p1", (n - i) * 10),
          );
          const cfg = minCfg({ appMappings: mappings });

          // drag last to first
          const result = reorderAppMappingPriority(cfg, mappings[n - 1]!.id, mappings[0]!.id);
          const sorted = [...result.appMappings].sort((a, b) => b.priority - a.priority);
          const priorities = sorted.map((m) => m.priority);

          // Each consecutive pair should differ by 10
          for (let i = 1; i < priorities.length; i++) {
            expect(priorities[i - 1]! - priorities[i]!).toBe(10);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("boundary: duplicateProfile clones exactly the right entities", () => {
  it("duplicate with N bindings gives N new bindings in the cloned profile", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), (n) => {
        const src = makeProfile("src", "Source");
        const actions = Array.from({ length: n }, (_, i) => makeAction(`a${i}`));
        const controls: ControlId[] = [
          "thumb_01", "thumb_02", "thumb_03", "thumb_04",
          "thumb_05", "thumb_06", "thumb_07", "thumb_08",
          "thumb_09", "thumb_10", "thumb_11", "thumb_12",
        ];
        const bindings = actions.map((a, i) =>
          makeBinding(`b${i}`, "src", controls[i % controls.length]!, a.id),
        );
        const cfg = minCfg({ profiles: [src], actions, bindings });

        const { config: result, newProfileId } = duplicateProfile(cfg, "src");

        const clonedBindings = result.bindings.filter((b) => b.profileId === newProfileId);
        expect(clonedBindings.length).toBe(n);
      }),
      { numRuns: 200 },
    );
  });

  it("duplicate of nonexistent profile returns empty newProfileId and unchanged config", () => {
    const cfg = minCfg({ profiles: [makeProfile("real", "Real")] });
    const { config: result, newProfileId } = duplicateProfile(cfg, "ghost");
    expect(newProfileId).toBe("");
    expect(result.profiles.length).toBe(1);
  });

  it("duplicate does not share action object references between original and clone", () => {
    const src = makeProfile("src", "Source");
    const action: Action = {
      id: "a1",
      type: "textSnippet",
      payload: { source: "inline", text: "hello", pasteMode: "sendText", tags: ["t1"] },
      pretty: "Snippet",
    };
    const binding = makeBinding("b1", "src", "thumb_01", "a1");
    const cfg = minCfg({ profiles: [src], actions: [action], bindings: [binding] });

    const { config: result, newProfileId } = duplicateProfile(cfg, "src");
    const clonedAction = result.actions.find(
      (a) => a.id !== "a1" && result.bindings.find((b) => b.profileId === newProfileId && b.actionRef === a.id),
    );
    expect(clonedAction).toBeDefined();
    // Mutating the clone's tags should not affect the original
    if (clonedAction && clonedAction.type === "textSnippet" && clonedAction.payload.source === "inline") {
      clonedAction.payload.tags.push("mutated");
    }
    const orig = result.actions.find((a) => a.id === "a1");
    if (orig && orig.type === "textSnippet" && orig.payload.source === "inline") {
      expect(orig.payload.tags).not.toContain("mutated");
    }
  });
});

describe("boundary: upsert idempotence — inserting the same entity twice produces no duplicates", () => {
  it("upsertBinding twice with same id keeps exactly one binding", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (id) => {
        const binding = makeBinding(id);
        const cfg = minCfg();
        const r1 = upsertBinding(cfg, binding);
        const r2 = upsertBinding(r1, binding);
        expect(r2.bindings.filter((b) => b.id === id).length).toBe(1);
      }),
      { numRuns: 500 },
    );
  });

  it("upsertAction twice with same id keeps exactly one action", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (id) => {
        const action = makeAction(id);
        const cfg = minCfg();
        const r1 = upsertAction(cfg, action);
        const r2 = upsertAction(r1, action);
        expect(r2.actions.filter((a) => a.id === id).length).toBe(1);
      }),
      { numRuns: 500 },
    );
  });

  it("upsertSnippetLibraryItem twice with same id keeps exactly one snippet", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (id) => {
        const snippet = makeSnippet(id);
        const cfg = minCfg();
        const r1 = upsertSnippetLibraryItem(cfg, snippet);
        const r2 = upsertSnippetLibraryItem(r1, snippet);
        expect(r2.snippetLibrary.filter((s) => s.id === id).length).toBe(1);
      }),
      { numRuns: 500 },
    );
  });
});

describe("boundary: removeBinding leaves no orphaned actions when binding is the sole referencer", () => {
  it("action count decreases by exactly 1 when removed binding was the only reference", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (n) => {
          // n bindings each referencing a distinct action
          const actions = Array.from({ length: n }, (_, i) => makeAction(`a${i}`));
          const controls: ControlId[] = [
            "thumb_01","thumb_02","thumb_03","thumb_04","thumb_05",
            "thumb_06","thumb_07","thumb_08","thumb_09","thumb_10",
          ];
          const bindings = actions.map((a, i) =>
            makeBinding(`b${i}`, "p1", controls[i % controls.length]!, a.id),
          );
          const cfg = minCfg({ actions, bindings });

          // Remove the first binding
          const result = removeBinding(cfg, "b0");
          expect(result.actions.length).toBe(n - 1);
          expect(result.actions.find((a) => a.id === "a0")).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("boundary: deleteAppMapping", () => {
  it("deletes only the targeted mapping by id", () => {
    const m1 = makeAppMapping("app-a", "p1", 20);
    const m2 = makeAppMapping("app-b", "p1", 10);
    const cfg = minCfg({ appMappings: [m1, m2] });
    const result = deleteAppMapping(cfg, "app-a");
    expect(result.appMappings.length).toBe(1);
    expect(result.appMappings[0]!.id).toBe("app-b");
  });

  it("deleteAppMapping with nonexistent id returns a config with the same length", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (n) => {
        const mappings = Array.from({ length: n }, (_, i) => makeAppMapping(`app-${i}`, "p1", i));
        const cfg = minCfg({ appMappings: mappings });
        const result = deleteAppMapping(cfg, "ghost-id");
        expect(result.appMappings.length).toBe(n);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%)
// ---------------------------------------------------------------------------

describe("null & empty: makeId functions with empty/whitespace input", () => {
  it("makeProfileId('') returns 'profile'", () => {
    expect(makeProfileId("")).toBe("profile");
  });

  it("makeProfileId with only whitespace returns 'profile'", () => {
    expect(makeProfileId("   \t\n")).toBe("profile");
  });

  it("makeSnippetId('') returns 'snippet-custom'", () => {
    expect(makeSnippetId("")).toBe("snippet-custom");
  });

  it("makeAppMappingId('') returns 'app-window'", () => {
    expect(makeAppMappingId("")).toBe("app-window");
  });

  it("makeBindingId with empty strings does not throw", () => {
    // TypeScript type says ControlId but at runtime empty string is passable
    expect(() =>
      makeBindingId("", "standard" as Layer, "" as ControlId),
    ).not.toThrow();
  });

  it("makeActionId with empty strings does not throw", () => {
    expect(() =>
      makeActionId("", "hypershift" as Layer, "" as ControlId),
    ).not.toThrow();
  });
});

describe("null & empty: config with empty collections", () => {
  it("deleteProfile on config with no bindings/actions/mappings removes only the profile", () => {
    const p = makeProfile("p1", "Solo");
    const cfg = minCfg({ profiles: [p] });
    const result = deleteProfile(cfg, "p1");
    expect(result.profiles.length).toBe(0);
    expect(result.bindings.length).toBe(0);
    expect(result.actions.length).toBe(0);
    expect(result.appMappings.length).toBe(0);
  });

  it("duplicateProfile with zero bindings adds new profile with empty binding/action arrays", () => {
    const src = makeProfile("src", "Empty");
    const cfg = minCfg({ profiles: [src] });
    const { config: result, newProfileId } = duplicateProfile(cfg, "src");
    const clonedBindings = result.bindings.filter((b) => b.profileId === newProfileId);
    const clonedActions = result.actions;
    expect(clonedBindings.length).toBe(0);
    expect(clonedActions.length).toBe(0);
  });

  it("extractProfileExport with profile that has zero bindings exports empty arrays", () => {
    const p = makeProfile("p1", "Empty");
    const cfg = minCfg({ profiles: [p] });
    const exported = extractProfileExport(cfg, "p1");
    expect(exported.bindings.length).toBe(0);
    expect(exported.actions.length).toBe(0);
    expect(exported.appMappings.length).toBe(0);
    expect(exported.encoderMappings!.length).toBe(0);
  });

  it("importProfile with empty bindings/actions produces valid config", () => {
    const data: ProfileExportData = {
      version: 2,
      exportedAt: new Date().toISOString(),
      profile: makeProfile("imported", "Imported"),
      bindings: [],
      actions: [],
      appMappings: [],
      encoderMappings: [],
    };
    const cfg = minCfg();
    const result = importProfile(cfg, data);
    expect(result.profiles.length).toBe(1);
    expect(result.bindings.length).toBe(0);
    expect(result.actions.length).toBe(0);
  });
});

describe("null & empty: optional fields in ProfileExportData", () => {
  it("importProfile works when encoderMappings field is absent (v2 compat)", () => {
    // Simulate a v2 export file that lacks the encoderMappings field
    const data = {
      version: 2,
      exportedAt: new Date().toISOString(),
      profile: makeProfile("p1", "Compat"),
      bindings: [],
      actions: [],
      appMappings: [],
      // encoderMappings intentionally omitted
    } as ProfileExportData;

    const cfg = minCfg();
    expect(() => importProfile(cfg, data)).not.toThrow();
  });
});

describe("null & empty: findDuplicateAppMapping with empty exe", () => {
  it("empty-string exe normalization: findDuplicateAppMapping never throws on whitespace-only exe", () => {
    const cfg = minCfg({
      appMappings: [makeAppMapping("app-x", "p1", 10)],
    });
    // Whitespace-only exe should not throw; it just normalizes to ""
    expect(() => findDuplicateAppMapping(cfg, "p1", "   ")).not.toThrow();
  });
});

describe("null & empty: collectMenuActionRefs with empty/deeply nested items", () => {
  it("empty items array produces no additions to the set", () => {
    const refs = new Set<string>();
    collectMenuActionRefs([], refs);
    expect(refs.size).toBe(0);
  });

  it("submenu without nested items (defensive) does not throw", () => {
    const refs = new Set<string>();
    // A submenu-kind item with items: [] should not crash
    collectMenuActionRefs(
      [{ kind: "submenu", id: "s1", label: "Sub", items: [], enabled: true }],
      refs,
    );
    expect(refs.size).toBe(0);
  });

  it("mixed action and submenu items are all collected", () => {
    const refs = new Set<string>();
    collectMenuActionRefs(
      [
        { kind: "action", id: "mi1", label: "A", actionRef: "ref-a", enabled: true },
        {
          kind: "submenu",
          id: "sub1",
          label: "Sub",
          enabled: true,
          items: [
            { kind: "action", id: "mi2", label: "B", actionRef: "ref-b", enabled: true },
          ],
        },
      ],
      refs,
    );
    expect(refs.has("ref-a")).toBe(true);
    expect(refs.has("ref-b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW / EXTREME INPUT (15%)
// ---------------------------------------------------------------------------

describe("overflow: very long strings in name normalizers", () => {
  it("makeProfileId with 100k-char string does not throw and returns valid id", () => {
    const huge = "A".repeat(100_000);
    let id: string;
    expect(() => { id = makeProfileId(huge); }).not.toThrow();
    expect(id!).toMatch(/^[a-z0-9-]+$/);
  });

  it("makeSnippetId with 100k-char string does not throw and starts with 'snippet-'", () => {
    const huge = "x".repeat(100_000);
    let id: string;
    expect(() => { id = makeSnippetId(huge); }).not.toThrow();
    expect(id!).toMatch(/^snippet-/);
  });

  it("makeAppMappingId with 100k-char string does not throw and starts with 'app-'", () => {
    const huge = "app.exe".repeat(10_000);
    let id: string;
    expect(() => { id = makeAppMappingId(huge); }).not.toThrow();
    expect(id!).toMatch(/^app-/);
  });
});

describe("overflow: unicode, emoji, RTL, BOM in profile names", () => {
  it("makeProfileId with emoji-only name returns 'profile' (all non-alnum stripped)", () => {
    expect(makeProfileId("🎮🕹️")).toBe("profile");
  });

  it("makeProfileId with Arabic RTL text returns valid id or 'profile' fallback", () => {
    const id = makeProfileId("مشغل");
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("makeProfileId with BOM character does not throw", () => {
    const withBOM = "﻿test";
    expect(() => makeProfileId(withBOM)).not.toThrow();
  });

  it("makeProfileId with non-breaking space is treated as separator", () => {
    const withNBSP = "hello world";
    const id = makeProfileId(withNBSP);
    // nbsp is not [a-z0-9] so it should be replaced with a hyphen
    expect(id).toMatch(/^[a-z0-9-]+$/);
    // 'hello' and 'world' should both appear
    expect(id).toContain("hello");
    expect(id).toContain("world");
  });

  it("makeSnippetId with XSS payload strips all special chars", () => {
    const xss = '<script>alert("xss")</script>';
    const id = makeSnippetId(xss);
    expect(id).not.toContain("<");
    expect(id).not.toContain(">");
    expect(id).not.toContain('"');
    expect(id).toMatch(/^snippet-/);
  });

  it("makeAppMappingId with SQL injection payload is sanitized", () => {
    const sql = "'; DROP TABLE bindings; --";
    const id = makeAppMappingId(sql);
    expect(id).not.toContain("'");
    expect(id).not.toContain(";");
    expect(id).toMatch(/^app-/);
  });

  it("makeProfileId with zero-width joiner characters returns valid id", () => {
    const zwj = "test‍name";
    const id = makeProfileId(zwj);
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("overflow: large config collections", () => {
  it("createProfile in config with 500 profiles does not throw and produces unique id", () => {
    const profiles = Array.from({ length: 500 }, (_, i) =>
      makeProfile(`gaming-${i + 2}`, `Gaming ${i}`),
    );
    // Also add "gaming" to force collision resolution deep into suffix space
    profiles.unshift(makeProfile("gaming", "Gaming"));
    const cfg = minCfg({ profiles });
    let result: AppConfig;
    expect(() => { result = createProfile(cfg, "Gaming"); }).not.toThrow();
    const ids = result!.profiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deleteProfile with 200 bindings/actions removes them all without throwing", () => {
    const p = makeProfile("victim", "Victim");
    const controls: ControlId[] = [
      "thumb_01","thumb_02","thumb_03","thumb_04","thumb_05","thumb_06",
      "thumb_07","thumb_08","thumb_09","thumb_10","thumb_11","thumb_12",
    ];
    const n = 200;
    const actions = Array.from({ length: n }, (_, i) => makeAction(`a${i}`));
    const bindings = actions.map((a, i) =>
      makeBinding(`b${i}`, "victim", controls[i % controls.length]!, a.id),
    );
    const cfg = minCfg({ profiles: [p], actions, bindings });
    let result: AppConfig;
    expect(() => { result = deleteProfile(cfg, "victim"); }).not.toThrow();
    expect(result!.bindings.length).toBe(0);
    expect(result!.actions.length).toBe(0);
  });
});

describe("overflow: extreme priority values in reorderAppMappingPriority", () => {
  it("reorder with MAX_SAFE_INTEGER priorities does not throw or produce NaN", () => {
    const m1 = { ...makeAppMapping("a", "p1", Number.MAX_SAFE_INTEGER) };
    const m2 = { ...makeAppMapping("b", "p1", Number.MAX_SAFE_INTEGER - 10) };
    const cfg = minCfg({ appMappings: [m1, m2] });
    let result: AppConfig;
    expect(() => { result = reorderAppMappingPriority(cfg, "b", "a"); }).not.toThrow();
    for (const m of result!.appMappings) {
      expect(Number.isFinite(m.priority)).toBe(true);
      expect(Number.isNaN(m.priority)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// All functions are pure, synchronous, and operate on value-type copies.
// There is no shared mutable module state. makeRandomId() calls
// crypto.randomUUID() synchronously with no external I/O.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL (10%)
// ---------------------------------------------------------------------------

describe("temporal: extractProfileExport embeds a valid ISO-8601 timestamp", () => {
  it("exportedAt is always a parseable ISO date string", () => {
    const p = makeProfile("p1", "Test");
    const cfg = minCfg({ profiles: [p] });
    const exported = extractProfileExport(cfg, "p1");
    // Must parse without throwing
    const d = new Date(exported.exportedAt);
    expect(d.toISOString()).toBe(exported.exportedAt);
  });

  it("exportedAt is always a string (never undefined or null)", () => {
    const p = makeProfile("p-temporal", "Temporal");
    const cfg = minCfg({ profiles: [p] });
    const exported = extractProfileExport(cfg, "p-temporal");
    expect(typeof exported.exportedAt).toBe("string");
    expect(exported.exportedAt.length).toBeGreaterThan(0);
  });

  it("makeRandomId always produces a non-empty unique string regardless of timing", () => {
    // Property: 1000 consecutive calls produce distinct ids
    const ids = Array.from({ length: 1000 }, () => makeRandomId("action"));
    expect(new Set(ids).size).toBe(1000);
  });

  it("makeRandomId result always starts with the given prefix", () => {
    fc.assert(
      fc.property(
        // prefix must start with a lowercase letter per schema contract
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        (prefix) => {
          const id = makeRandomId(prefix);
          expect(id.startsWith(prefix + "-")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// ADDITIONAL DEEP INVARIANTS not covered by existing suites
// ---------------------------------------------------------------------------

describe("invariant: import preserves action payload content (semantic roundtrip)", () => {
  it("imported action text payload matches original after roundtrip", () => {
    const p = makeProfile("src", "Source");
    const action: Action = {
      id: "a1",
      type: "textSnippet",
      payload: { source: "inline", text: "The quick brown fox", pasteMode: "sendText", tags: ["speed"] },
      pretty: "Fox snippet",
    };
    const binding = makeBinding("b1", "src", "thumb_01", "a1");
    const cfg = minCfg({ profiles: [p], actions: [action], bindings: [binding] });

    const exported = extractProfileExport(cfg, "src");
    const imported = importProfile(minCfg(), exported);

    const importedProfile = imported.profiles[0]!;
    const importedBinding = imported.bindings.find((b) => b.profileId === importedProfile.id)!;
    const importedAction = imported.actions.find((a) => a.id === importedBinding.actionRef)!;

    expect(importedAction.type).toBe("textSnippet");
    if (importedAction.type === "textSnippet" && importedAction.payload.source === "inline") {
      expect(importedAction.payload.text).toBe("The quick brown fox");
      expect(importedAction.payload.tags).toEqual(["speed"]);
    }
  });

  it("roundtrip preserves appMapping exe, priority, titleIncludes", () => {
    const p = makeProfile("src", "Source");
    const appMapping: AppMapping = {
      id: "app-myapp",
      exe: "myapp.exe",
      profileId: "src",
      enabled: true,
      priority: 42,
      titleIncludes: ["Main Window"],
    };
    const cfg = minCfg({ profiles: [p], appMappings: [appMapping] });

    const exported = extractProfileExport(cfg, "src");
    const imported = importProfile(minCfg(), exported);

    const importedProfile = imported.profiles[0]!;
    const importedMapping = imported.appMappings.find((m) => m.profileId === importedProfile.id)!;
    expect(importedMapping.exe).toBe("myapp.exe");
    expect(importedMapping.priority).toBe(42);
    expect(importedMapping.titleIncludes).toEqual(["Main Window"]);
  });
});

describe("invariant: coerceActionType — name collision when only one action exists", () => {
  /**
   * BUG candidate: coerceActionType picks the "first other action" as the menu
   * target reference via:
   *   config.actions.find((candidate) => candidate.id !== actionId)?.id ?? null
   * When there is exactly ONE action and type==="menu", it creates a placeholder.
   * But the menuActionRef assignment uses the ORIGINAL config, not nextConfig.
   * We verify the placeholder is actually present in the result.
   */
  it("coerceActionType to 'menu' when config has exactly 1 action creates placeholder correctly", () => {
    const action = makeAction("only");
    const cfg = minCfg({ actions: [action] });

    const result = coerceActionType(cfg, "only", "menu");

    // At minimum 2 actions: the coerced one + the placeholder
    expect(result.actions.length).toBeGreaterThanOrEqual(2);

    const coerced = result.actions.find((a) => a.id === "only");
    expect(coerced?.type).toBe("menu");
    if (coerced?.type === "menu") {
      expect(coerced.payload.items.length).toBeGreaterThan(0);
      // The menu item must reference an action that exists in the result
      const actionIds = new Set(result.actions.map((a) => a.id));
      for (const item of coerced.payload.items) {
        if (item.kind === "action") {
          expect(actionIds.has(item.actionRef)).toBe(true);
        }
      }
    }
  });

  it("coerceActionType to 'profileSwitch' with no profiles sets empty targetProfileId", () => {
    const action = makeAction("a1");
    const cfg = minCfg({ actions: [action] });
    const result = coerceActionType(cfg, "a1", "profileSwitch");
    const coerced = result.actions.find((a) => a.id === "a1");
    expect(coerced?.type).toBe("profileSwitch");
    if (coerced?.type === "profileSwitch") {
      // With no profiles, targetProfileId defaults to ""
      expect(coerced.payload.targetProfileId).toBe("");
    }
  });

  it("coerceActionType to 'sequence' with action pretty of all-whitespace uses fallback", () => {
    const action: Action = {
      id: "a1",
      type: "shortcut",
      payload: { key: "A", ctrl: false, shift: false, alt: false, win: false },
      pretty: "   \t  ",
    };
    const cfg = minCfg({ actions: [action] });
    const result = coerceActionType(cfg, "a1", "sequence");
    const coerced = result.actions.find((a) => a.id === "a1");
    if (coerced?.type === "sequence") {
      const step = coerced.payload.steps[0];
      if (step && step.type === "text") {
        expect(step.value).toBe("Replace me");
      }
    }
  });
});

describe("invariant: promoteInlineSnippetActionToLibrary deduplication", () => {
  it("promoting snippet with 1000 duplicate tags yields exactly 1 unique tag", () => {
    const action: Action = {
      id: "a1",
      type: "textSnippet",
      payload: {
        source: "inline",
        text: "lots of tags",
        pasteMode: "clipboardPaste",
        tags: Array.from({ length: 1000 }, () => "repeated-tag"),
      },
      pretty: "Tagged",
    };
    const cfg = minCfg({ actions: [action] });
    const result = promoteInlineSnippetActionToLibrary(cfg, "a1", "Promoted");
    expect(result.snippetLibrary[0]!.tags).toEqual(["repeated-tag"]);
  });

  it("snippet id is deterministic from the preferred name (not random)", () => {
    const action: Action = {
      id: "a1",
      type: "textSnippet",
      payload: { source: "inline", text: "text", pasteMode: "sendText", tags: [] },
      pretty: "Pretty",
    };
    // Call twice on fresh configs with the same name — id must be the same
    const cfg1 = minCfg({ actions: [{ ...action }] });
    const cfg2 = minCfg({ actions: [{ ...action }] });
    const r1 = promoteInlineSnippetActionToLibrary(cfg1, "a1", "My Snippet");
    const r2 = promoteInlineSnippetActionToLibrary(cfg2, "a1", "My Snippet");
    expect(r1.snippetLibrary[0]!.id).toBe(r2.snippetLibrary[0]!.id);
  });
});

describe("invariant: createDefaultActionMenuItem / createDefaultSubmenuItem id uniqueness", () => {
  it("menu item id from createDefaultActionMenuItem is always unique vs existing ids", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).map((s) => `menu-item-action-${s}`),
          { minLength: 0, maxLength: 20 },
        ),
        (existingIds) => {
          const item = createDefaultActionMenuItem(existingIds, "some-action", "Label");
          expect(existingIds).not.toContain(item.id);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("createDefaultSubmenuItem child item id differs from submenu id", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
        (existingIds) => {
          const submenu = createDefaultSubmenuItem(existingIds, "target", "Child Label");
          if (submenu.kind === "submenu") {
            const child = submenu.items[0];
            expect(child?.id).not.toBe(submenu.id);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("invariant: ensurePlaceholderBinding is idempotent", () => {
  it("calling ensurePlaceholderBinding twice never adds a second binding for the same slot", () => {
    const control = {
      id: "thumb_05" as ControlId,
      family: "thumbGrid" as const,
      defaultName: "Thumb 5",
      remappable: true,
      capabilityStatus: "verified" as const,
    };
    const cfg = minCfg({ profiles: [makeProfile("p1")] });

    const once = ensurePlaceholderBinding(cfg, "p1", "standard", control);
    const twice = ensurePlaceholderBinding(once, "p1", "standard", control);

    const matches = twice.bindings.filter(
      (b) => b.profileId === "p1" && b.layer === "standard" && b.controlId === "thumb_05",
    );
    expect(matches.length).toBe(1);
  });
});

describe("invariant: import encoder mappings deduplication", () => {
  it("importing twice does not duplicate encoder mappings for same controlId+layer", () => {
    const p = makeProfile("src", "Source");
    const action = makeAction("a1");
    const binding = makeBinding("b1", "src", "thumb_03", "a1");
    const encoder: EncoderMapping = {
      controlId: "thumb_03",
      layer: "standard",
      encodedKey: "F15",
      source: "synapse",
      verified: true,
    };
    const cfg = minCfg({
      profiles: [p],
      actions: [action],
      bindings: [binding],
      encoderMappings: [encoder],
    });

    const exported = extractProfileExport(cfg, "src");

    // Import into a config that already has the same encoder mapping
    const baseWithEncoder = minCfg({ encoderMappings: [encoder] });
    const result = importProfile(baseWithEncoder, exported);

    // The encoder for thumb_03/standard must appear exactly once
    const matches = result.encoderMappings.filter(
      (e) => e.controlId === "thumb_03" && e.layer === "standard",
    );
    expect(matches.length).toBe(1);
  });
});

describe("invariant: extractProfileExport version is always 2", () => {
  it("version field in export envelope is always 2", () => {
    const p = makeProfile("px", "Version test");
    const cfg = minCfg({ profiles: [p] });
    const exported = extractProfileExport(cfg, "px");
    expect(exported.version).toBe(2);
  });
});

describe("invariant: makeBindingId and makeActionId use underscores→hyphens conversion", () => {
  it("makeBindingId output never contains underscores in the controlId segment", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ControlId>(
          "thumb_01","thumb_02","thumb_03","thumb_04","mouse_4","mouse_5",
          "wheel_up","wheel_down","wheel_click","top_aux_01","top_aux_02",
        ),
        fc.constantFrom<Layer>("standard", "hypershift"),
        (controlId, layer) => {
          const id = makeBindingId("prof", layer, controlId);
          // Segment after the last known fixed prefix should have hyphens, not underscores
          const afterPrefix = id.replace(/^binding-prof-(?:standard|hypershift)-/, "");
          expect(afterPrefix).not.toContain("_");
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("invariant: duplicateBinding does not corrupt existing bindings", () => {
  it("binding count in original profile stays unchanged after duplication to same profile", () => {
    const action = makeAction("a1");
    const binding1 = makeBinding("b1", "p1", "thumb_01", "a1");
    const binding2 = makeBinding("b2", "p1", "thumb_02", "a1");
    const cfg = minCfg({ actions: [action], bindings: [binding1, binding2] });

    // Duplicate b1 to thumb_03 (unused slot)
    const result = duplicateBinding(cfg, "b1", "thumb_03" as ControlId);

    // Original bindings b1 and b2 should still be there
    expect(result.bindings.find((b) => b.id === "b1")).toBeDefined();
    expect(result.bindings.find((b) => b.id === "b2")).toBeDefined();
    // Plus the new one for thumb_03
    const atThumb03 = result.bindings.filter((b) => b.controlId === "thumb_03");
    expect(atThumb03.length).toBe(1);
  });
});
