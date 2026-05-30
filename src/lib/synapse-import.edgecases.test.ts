/**
 * synapse-import.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for synapse-import.ts.
 *
 * Note: synapse-import.ts is a pure TypeScript TYPE/INTERFACE definition file.
 * It exports zero runtime functions — only types and interfaces. There is no
 * executable logic to test with vitest. All invariants that involve these types
 * are enforced at compile-time by TypeScript's type-checker.
 *
 * Runtime coverage strategy:
 *   Instead of testing the module itself, we test the STRUCTURAL INTEGRITY of
 *   objects conforming to the exported interfaces using fast-check arbitraries.
 *   These tests verify:
 *     1. The discriminated union ParsedAction satisfies all `kind` variants.
 *     2. ParsedSequenceStep covers both `kind` variants.
 *     3. ImportSummary counters are non-negative integers.
 *     4. MergeStrategy accepts both valid string values.
 *     5. ImportWarning always has `code` and `message` (required fields).
 *
 * Categories:
 *   - Boundary (40%): all `kind` discriminants of ParsedAction/ParsedSequenceStep
 *   - Null & empty (20%): optional fields (context?, selectedProfileGuids?,
 *     mergeStrategy?) are truly optional
 *   - Overflow (15%): 100k-char strings in message/code/path fields
 *   - Concurrency (N/A): pure type definitions, no runtime logic
 *   - Temporal (N/A): no time-dependent fields in synapse-import.ts
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type {
  ParsedAction,
  ParsedBinding,
  ParsedMacro,
  ParsedProfile,
  ParsedSequenceStep,
  ImportWarning,
  ImportOptions,
  ImportSummary,
  MergeStrategy,
  SourceKind,
} from "./synapse-import";

// ---------------------------------------------------------------------------
// BOUNDARY (40%) — all discriminated union `kind` variants
// ---------------------------------------------------------------------------

describe("boundary: ParsedAction — all kind variants are structurally valid", () => {
  it("shortcut kind with all modifier fields", () => {
    const action: ParsedAction = {
      kind: "shortcut",
      key: "A",
      ctrl: true,
      shift: false,
      alt: false,
      win: false,
    };
    expect(action.kind).toBe("shortcut");
    expect(action.key).toBe("A");
  });

  it("shortcut kind with only required key field (modifiers optional)", () => {
    // All modifier booleans are optional in the type
    const action: ParsedAction = { kind: "shortcut", key: "F5" };
    expect(action.kind).toBe("shortcut");
    expect(action.key).toBe("F5");
  });

  it("textSnippet kind with non-empty text", () => {
    const action: ParsedAction = { kind: "textSnippet", text: "Hello, world!" };
    expect(action.kind).toBe("textSnippet");
    expect(action.text.length).toBeGreaterThan(0);
  });

  it("textSnippet kind with empty text (edge case — allowed by type)", () => {
    const action: ParsedAction = { kind: "textSnippet", text: "" };
    expect(action.kind).toBe("textSnippet");
    expect(action.text).toBe("");
  });

  it("sequence kind with a synapseGuid", () => {
    const action: ParsedAction = { kind: "sequence", macroGuid: "abc-def-123" };
    expect(action.kind).toBe("sequence");
    expect(action.macroGuid).toBe("abc-def-123");
  });

  it("mouseAction kind with action string", () => {
    const action: ParsedAction = { kind: "mouseAction", action: "leftClick" };
    expect(action.kind).toBe("mouseAction");
  });

  it("disabled kind has no extra fields required", () => {
    const action: ParsedAction = { kind: "disabled" };
    expect(action.kind).toBe("disabled");
  });

  it("unmappable kind requires a reason string", () => {
    const action: ParsedAction = { kind: "unmappable", reason: "Reserved by Synapse" };
    expect(action.kind).toBe("unmappable");
    expect(action.reason.length).toBeGreaterThan(0);
  });

  it("PBT: all 6 ParsedAction kinds round-trip through kind check", () => {
    type Kind = ParsedAction["kind"];
    const ALL_KINDS: Kind[] = [
      "shortcut", "textSnippet", "sequence", "mouseAction", "disabled", "unmappable",
    ];

    fc.assert(
      fc.property(fc.constantFrom(...ALL_KINDS), (kind) => {
        let action: ParsedAction;
        switch (kind) {
          case "shortcut":   action = { kind, key: "A" }; break;
          case "textSnippet": action = { kind, text: "t" }; break;
          case "sequence":   action = { kind, macroGuid: "g" }; break;
          case "mouseAction": action = { kind, action: "leftClick" }; break;
          case "disabled":   action = { kind }; break;
          case "unmappable": action = { kind, reason: "r" }; break;
        }
        expect(action.kind).toBe(kind);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: ParsedSequenceStep — both step kinds", () => {
  it("send step carries a non-empty value", () => {
    const step: ParsedSequenceStep = { kind: "send", value: "Ctrl+C" };
    expect(step.kind).toBe("send");
    expect(step.value.length).toBeGreaterThan(0);
  });

  it("sleep step carries a non-negative delayMs", () => {
    const step: ParsedSequenceStep = { kind: "sleep", delayMs: 100 };
    expect(step.kind).toBe("sleep");
    expect(step.delayMs).toBeGreaterThanOrEqual(0);
  });

  it("PBT: sleep delayMs is always non-negative (structural invariant)", () => {
    fc.assert(
      fc.property(fc.nat(), (delayMs) => {
        const step: ParsedSequenceStep = { kind: "sleep", delayMs };
        expect(step.delayMs).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: ParsedProfile — structural integrity", () => {
  it("profile with empty bindings and macros arrays is valid", () => {
    const profile: ParsedProfile = {
      synapseGuid: "guid-abc",
      name: "My Profile",
      bindings: [],
      macros: [],
    };
    expect(profile.bindings.length).toBe(0);
    expect(profile.macros.length).toBe(0);
  });

  it("PBT: ParsedProfile with N bindings preserves all bindings", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        const bindings: ParsedBinding[] = Array.from({ length: n }, (_, i) => ({
          controlId: `thumb_0${i % 12 + 1}`,
          layer: "standard" as const,
          sourceInputId: `src-${i}`,
          label: `Binding ${i}`,
          action: { kind: "disabled" as const },
        }));
        const profile: ParsedProfile = {
          synapseGuid: "guid",
          name: "Profile",
          bindings,
          macros: [],
        };
        expect(profile.bindings.length).toBe(n);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: ParsedMacro — steps array integrity", () => {
  it("macro with zero steps is a valid empty sequence", () => {
    const macro: ParsedMacro = {
      synapseGuid: "m-guid",
      name: "Empty Macro",
      steps: [],
    };
    expect(macro.steps.length).toBe(0);
  });

  it("macro with alternating send/sleep steps preserves order", () => {
    const steps: ParsedSequenceStep[] = [
      { kind: "send", value: "Ctrl+C" },
      { kind: "sleep", delayMs: 50 },
      { kind: "send", value: "Ctrl+V" },
    ];
    const macro: ParsedMacro = { synapseGuid: "m2", name: "Copy-Pause-Paste", steps };
    expect(macro.steps[0]?.kind).toBe("send");
    expect(macro.steps[1]?.kind).toBe("sleep");
    expect(macro.steps[2]?.kind).toBe("send");
  });
});

describe("boundary: SourceKind — only 'synapseV4' is a valid value", () => {
  it("SourceKind literal 'synapseV4' is accepted", () => {
    const kind: SourceKind = "synapseV4";
    expect(kind).toBe("synapseV4");
  });
});

describe("boundary: MergeStrategy — both valid values", () => {
  it("'append' and 'replaceByName' are both valid MergeStrategy values", () => {
    const strategies: MergeStrategy[] = ["append", "replaceByName"];
    for (const s of strategies) {
      expect(["append", "replaceByName"]).toContain(s);
    }
  });
});

describe("boundary: ImportSummary — all counters are non-negative integers", () => {
  it("PBT: any ImportSummary with valid fields has non-negative counters", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (profilesAdded, bindingsAdded, actionsAdded, macrosAdded, skipped) => {
          const summary: ImportSummary = {
            profilesAdded,
            bindingsAdded,
            actionsAdded,
            macrosAdded,
            skipped,
          };
          expect(summary.profilesAdded).toBeGreaterThanOrEqual(0);
          expect(summary.bindingsAdded).toBeGreaterThanOrEqual(0);
          expect(summary.actionsAdded).toBeGreaterThanOrEqual(0);
          expect(summary.macrosAdded).toBeGreaterThanOrEqual(0);
          expect(summary.skipped).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%) — optional fields
// ---------------------------------------------------------------------------

describe("null & empty: ImportOptions — all fields optional", () => {
  it("ImportOptions with no fields is valid (empty object)", () => {
    const opts: ImportOptions = {};
    expect(opts.selectedProfileGuids).toBeUndefined();
    expect(opts.mergeStrategy).toBeUndefined();
  });

  it("ImportOptions with empty selectedProfileGuids array is valid", () => {
    const opts: ImportOptions = { selectedProfileGuids: [] };
    expect(opts.selectedProfileGuids).toEqual([]);
  });

  it("ImportOptions with mergeStrategy only is valid", () => {
    const opts: ImportOptions = { mergeStrategy: "append" };
    expect(opts.mergeStrategy).toBe("append");
  });
});

describe("null & empty: ImportWarning — context field is optional", () => {
  it("warning without context field is valid", () => {
    const warning: ImportWarning = {
      code: "WARN_001",
      message: "Something happened",
    };
    expect(warning.context).toBeUndefined();
    expect(warning.code).toBe("WARN_001");
    expect(warning.message.length).toBeGreaterThan(0);
  });

  it("warning with empty string context is accepted (structural)", () => {
    const warning: ImportWarning = {
      code: "W",
      message: "M",
      context: "",
    };
    expect(warning.context).toBe("");
  });
});

describe("null & empty: ParsedBinding — both layer values accepted", () => {
  it.each(["standard", "hypershift"] as const)("layer=%s is a valid ParsedBinding layer", (layer) => {
    const binding: ParsedBinding = {
      controlId: "thumb_01",
      layer,
      sourceInputId: "sid",
      label: "My Binding",
      action: { kind: "disabled" },
    };
    expect(binding.layer).toBe(layer);
  });
});

describe("null & empty: ParsedProfile with empty name", () => {
  it("empty name string is allowed by the type (callers must validate)", () => {
    // The ParsedProfile type has no minimum-length constraint on name.
    // An empty name could cause UI issues — callers must validate.
    const profile: ParsedProfile = {
      synapseGuid: "guid",
      name: "",
      bindings: [],
      macros: [],
    };
    expect(profile.name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW (15%)
// ---------------------------------------------------------------------------

describe("overflow: ImportWarning with 100k-char fields", () => {
  it("very long code and message strings are structurally valid (no truncation in type)", () => {
    const huge = "X".repeat(100_000);
    const warning: ImportWarning = {
      code: huge,
      message: huge,
      context: huge,
    };
    expect(warning.code.length).toBe(100_000);
    expect(warning.message.length).toBe(100_000);
    expect(warning.context?.length).toBe(100_000);
  });
});

describe("overflow: ParsedProfile with 1000 bindings and 1000 macros", () => {
  it("does not throw when constructing a large ParsedProfile object", () => {
    const bindings: ParsedBinding[] = Array.from({ length: 1000 }, (_, i) => ({
      controlId: `ctrl-${i}`,
      layer: "standard" as const,
      sourceInputId: `src-${i}`,
      label: `B ${i}`,
      action: { kind: "disabled" as const },
    }));
    const macros: ParsedMacro[] = Array.from({ length: 1000 }, (_, i) => ({
      synapseGuid: `guid-${i}`,
      name: `Macro ${i}`,
      steps: [{ kind: "send" as const, value: `step-${i}` }],
    }));
    let profile: ParsedProfile;
    expect(() => {
      profile = { synapseGuid: "big-profile", name: "Big", bindings, macros };
    }).not.toThrow();
    expect(profile!.bindings.length).toBe(1000);
    expect(profile!.macros.length).toBe(1000);
  });
});

describe("overflow: ParsedMacro with 10k send steps", () => {
  it("10000-step macro is constructed without throwing", () => {
    const steps: ParsedSequenceStep[] = Array.from({ length: 10_000 }, (_, i) => ({
      kind: "send" as const,
      value: `step-${i}`,
    }));
    const macro: ParsedMacro = { synapseGuid: "m", name: "Huge", steps };
    expect(macro.steps.length).toBe(10_000);
  });
});

describe("overflow: ParsedAction shortcut with 100k-char key", () => {
  it("100k-char key in shortcut action is structurally allowed by the type", () => {
    const action: ParsedAction = { kind: "shortcut", key: "K".repeat(100_000) };
    expect((action as { kind: "shortcut"; key: string }).key.length).toBe(100_000);
  });
});

describe("overflow: ImportSummary with Number.MAX_SAFE_INTEGER counters", () => {
  it("extreme counter values are structurally valid (no overflow check in type)", () => {
    const summary: ImportSummary = {
      profilesAdded: Number.MAX_SAFE_INTEGER,
      bindingsAdded: Number.MAX_SAFE_INTEGER,
      actionsAdded: Number.MAX_SAFE_INTEGER,
      macrosAdded: Number.MAX_SAFE_INTEGER,
      skipped: Number.MAX_SAFE_INTEGER,
    };
    expect(Number.isFinite(summary.profilesAdded)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// synapse-import.ts exports only types and interfaces — zero runtime logic.
// There is no concurrent or async surface to test.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL — N/A
// No timestamp or ID-generation fields exist in synapse-import.ts types.
// ---------------------------------------------------------------------------
