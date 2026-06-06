/**
 * action-helpers.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for action-helpers.ts.
 * Targets invariants NOT already covered by action-helpers.test.ts.
 *
 * What's already in action-helpers.test.ts:
 *   - describeActionSummary: all action types, null, modifiers, snippet sources
 *   - isActionLiveRunnable: all action types, key presence, snippet resolution
 *   - withShortcutPayload / withTextSnippetPayload / withSequencePayload /
 *     withLaunchPayload / withMenuPayload: transform + no-op for wrong type
 *   - createDefaultSequenceStep: all 4 types
 *   - coerceSequenceStepType: most source→target combinations
 *   - setSequenceStepDelay: all 4 step types
 *
 * New invariants added here:
 *   - describeActionSummary: PBT totality (never throws for any action type)
 *   - mouseActionLabel / mediaKeyLabel: totality over all known values + unknown
 *   - isActionLiveRunnable: menu/profileSwitch always false regardless of payload
 *   - with*Payload idempotence/composability
 *   - coerceSequenceStepType: idempotence (same type → same object reference)
 *   - setSequenceStepDelay: extreme delay values (0, MAX_SAFE_INTEGER, negative)
 *   - Overflow: 100k-char payload values, huge step lists
 *
 * Categories:
 *   - Boundary (40%)
 *   - Null & empty (20%)
 *   - Overflow (15%)
 *   - Concurrency (N/A): all functions are pure, synchronous.
 *   - Temporal (N/A): no time-dependent surfaces in action-helpers.ts.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type {
  Action,
  MediaKeyKind,
  MouseActionKind,
  PasteMode,
  SequenceStep,
} from "./config";
import {
  describeActionSummary,
  isActionLiveRunnable,
  mouseActionLabel,
  mediaKeyLabel,
  withShortcutPayload,
  createDefaultSequenceStep,
  coerceSequenceStepType,
  setSequenceStepDelay,
} from "./action-helpers";
import {
  MOUSE_ACTION_OPTIONS,
  MEDIA_KEY_OPTIONS,
} from "./constants";
import { makeAction, makeConfig, emptySnippets } from "./test-fixtures";

// ---------------------------------------------------------------------------
// All known MouseActionKind and MediaKeyKind values — must stay in sync with
// config.ts. If a new variant is added to either union but not to the OPTIONS
// arrays, mouseActionLabel/mediaKeyLabel will return undefined for it.
// ---------------------------------------------------------------------------

const ALL_MOUSE_KINDS: MouseActionKind[] = [
  "leftClick",
  "rightClick",
  "middleClick",
  "doubleClick",
  "scrollUp",
  "scrollDown",
  "scrollLeft",
  "scrollRight",
  "mouseBack",
  "mouseForward",
];

const ALL_MEDIA_KEY_KINDS: MediaKeyKind[] = [
  "playPause",
  "nextTrack",
  "prevTrack",
  "stop",
  "volumeUp",
  "volumeDown",
  "mute",
];

const ALL_STEP_TYPES: SequenceStep["type"][] = ["send", "text", "sleep", "launch"];

// ---------------------------------------------------------------------------
// BOUNDARY (40%)
// ---------------------------------------------------------------------------

describe("boundary: mouseActionLabel — totality over all MouseActionKind values", () => {
  it("every MouseActionKind in ALL_MOUSE_KINDS returns a defined, non-empty label", () => {
    for (const kind of ALL_MOUSE_KINDS) {
      const label = mouseActionLabel(kind);
      expect(label, `mouseActionLabel("${kind}") must be defined`).toBeDefined();
      expect(
        (label as string).trim().length,
        `mouseActionLabel("${kind}") must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("MOUSE_ACTION_OPTIONS covers all ALL_MOUSE_KINDS (totality guard)", () => {
    const optionValues = new Set(MOUSE_ACTION_OPTIONS.map((o) => o.value));
    for (const kind of ALL_MOUSE_KINDS) {
      expect(
        optionValues.has(kind),
        `MOUSE_ACTION_OPTIONS is missing entry for "${kind}"`,
      ).toBe(true);
    }
  });

  it("no two MouseActionKind values share the same label (drift guard)", () => {
    const labels = ALL_MOUSE_KINDS.map((k) => mouseActionLabel(k)!);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("mouseActionLabel returns undefined for unknown kind (not throwing)", () => {
    const result = mouseActionLabel("__unknown__");
    expect(result).toBeUndefined();
  });

  it("mouseActionLabel is deterministic (PBT)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_MOUSE_KINDS), (kind) => {
        expect(mouseActionLabel(kind)).toBe(mouseActionLabel(kind));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: mediaKeyLabel — totality over all MediaKeyKind values", () => {
  it("every MediaKeyKind in ALL_MEDIA_KEY_KINDS returns a defined, non-empty label", () => {
    for (const kind of ALL_MEDIA_KEY_KINDS) {
      const label = mediaKeyLabel(kind);
      expect(label, `mediaKeyLabel("${kind}") must be defined`).toBeDefined();
      expect(
        (label as string).trim().length,
        `mediaKeyLabel("${kind}") must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("MEDIA_KEY_OPTIONS covers all ALL_MEDIA_KEY_KINDS (totality guard)", () => {
    const optionValues = new Set(MEDIA_KEY_OPTIONS.map((o) => o.value));
    for (const kind of ALL_MEDIA_KEY_KINDS) {
      expect(
        optionValues.has(kind),
        `MEDIA_KEY_OPTIONS is missing entry for "${kind}"`,
      ).toBe(true);
    }
  });

  it("no two MediaKeyKind values share the same label (drift guard)", () => {
    const labels = ALL_MEDIA_KEY_KINDS.map((k) => mediaKeyLabel(k)!);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("mediaKeyLabel returns undefined for unknown key (not throwing)", () => {
    const result = mediaKeyLabel("__nonexistent__");
    expect(result).toBeUndefined();
  });
});

describe("boundary: describeActionSummary — totality (never throws for any action type)", () => {
  it("describeActionSummary(null, ...) returns a non-empty string without throwing", () => {
    const result = describeActionSummary(null, emptySnippets);
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it("describeActionSummary is non-empty for all action type variants (PBT over types)", () => {
    const allActions: Action[] = [
      makeAction({ type: "shortcut", payload: { key: "A", ctrl: false, shift: false, alt: false, win: false } }),
      makeAction({ type: "textSnippet", payload: { source: "inline", text: "hi", pasteMode: "clipboardPaste" as PasteMode, tags: [] } }),
      makeAction({ type: "sequence", payload: { steps: [] } }),
      makeAction({ type: "launch", payload: { target: "app.exe" } }),
      makeAction({ type: "menu", payload: { items: [] } }),
      makeAction({ type: "mouseAction", payload: { action: "leftClick" } }),
      makeAction({ type: "mediaKey", payload: { key: "playPause" } }),
      makeAction({ type: "profileSwitch", payload: { targetProfileId: "p1" } }),
      makeAction({ type: "disabled", payload: {} }),
    ];

    for (const action of allActions) {
      let result: string;
      expect(
        () => { result = describeActionSummary(action, emptySnippets); },
        `describeActionSummary must not throw for type "${action.type}"`,
      ).not.toThrow();
      expect(result!.trim().length, `describeActionSummary must return non-empty for type "${action.type}"`).toBeGreaterThan(0);
    }
  });
});

describe("boundary: isActionLiveRunnable — menu and profileSwitch always false", () => {
  it("menu action with many items is still not live-runnable", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (n) => {
        const items = Array.from({ length: n }, (_, i) => ({
          kind: "action" as const,
          id: `mi${i}`,
          label: `Item ${i}`,
          actionId: `a${i}`,
          enabled: true,
        }));
        const config = makeConfig({
          actions: [makeAction({ id: "a1", type: "menu", payload: { items } })],
        });
        expect(isActionLiveRunnable(config, "a1")).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it("profileSwitch with any targetProfileId is not live-runnable", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (profileId) => {
        const config = makeConfig({
          actions: [makeAction({ id: "a1", type: "profileSwitch", payload: { targetProfileId: profileId } })],
        });
        expect(isActionLiveRunnable(config, "a1")).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: coerceSequenceStepType — same-type conversion is identity (idempotence)", () => {
  it("same-type coercion returns the same object reference (no unnecessary copy)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STEP_TYPES), (stepType) => {
        const step = createDefaultSequenceStep(stepType);
        const result = coerceSequenceStepType(step, stepType);
        // The implementation guards with `if (step.type === nextType) return step;`
        expect(result).toBe(step);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: coerceSequenceStepType — all source→target type pairs do not throw", () => {
  it("every source×target combination produces a valid step without throwing (PBT)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STEP_TYPES),
        fc.constantFrom(...ALL_STEP_TYPES),
        (fromType, toType) => {
          const step = createDefaultSequenceStep(fromType);
          let result: SequenceStep;
          expect(() => {
            result = coerceSequenceStepType(step, toType);
          }).not.toThrow();
          expect(result!.type).toBe(toType);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: setSequenceStepDelay — extreme delay values", () => {
  it("setSequenceStepDelay with delay=0 on non-sleep step sets delayMs=0 (falsy but valid)", () => {
    const step: SequenceStep = { type: "send", value: "Ctrl+C" };
    const result = setSequenceStepDelay(step, 0);
    if (result.type !== "sleep") {
      expect(result.delayMs).toBe(0);
    }
  });

  it("setSequenceStepDelay with delay=Number.MAX_SAFE_INTEGER does not throw", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STEP_TYPES), (stepType) => {
        const step = createDefaultSequenceStep(stepType);
        let result: SequenceStep;
        expect(() => {
          result = setSequenceStepDelay(step, Number.MAX_SAFE_INTEGER);
        }).not.toThrow();
        if (result!.type === "sleep") {
          expect(result!.delayMs).toBe(Number.MAX_SAFE_INTEGER);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("setSequenceStepDelay clamps a negative delay to 0", () => {
    // Negative delays are clamped to 0 — a negative delayMs would serialize to a
    // negative JSON number and fail Rust's u32 deserialization on save/load.
    const step: SequenceStep = { type: "sleep", delayMs: 100 };
    let result: SequenceStep;
    expect(() => {
      result = setSequenceStepDelay(step, -500);
    }).not.toThrow();
    if (result!.type === "sleep") {
      expect(result!.delayMs).toBe(0);
    }
  });
});

describe("boundary: createDefaultSequenceStep — all types produce valid steps", () => {
  it("every SequenceStep type produces a non-null step with the correct type field (PBT)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STEP_TYPES), (stepType) => {
        const step = createDefaultSequenceStep(stepType);
        expect(step.type).toBe(stepType);
      }),
      { numRuns: 1000 },
    );
  });

  it("sleep step always has a positive default delayMs", () => {
    const step = createDefaultSequenceStep("sleep");
    if (step.type === "sleep") {
      expect(step.delayMs).toBeGreaterThan(0);
    }
  });

  it("send/text/launch steps always have a non-empty default value", () => {
    for (const type of ["send", "text", "launch"] as const) {
      const step = createDefaultSequenceStep(type);
      if ("value" in step) {
        expect(step.value.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%)
// ---------------------------------------------------------------------------

describe("null & empty: with*Payload functions — wrong type is strict no-op", () => {
  it("withShortcutPayload on every non-shortcut type returns the original action (PBT)", () => {
    const nonShortcutTypes = ["textSnippet", "sequence", "launch", "menu", "mouseAction", "mediaKey", "profileSwitch", "disabled"] as const;
    fc.assert(
      fc.property(fc.constantFrom(...nonShortcutTypes), (type) => {
        // Build a minimal valid action for each type
        let action: Action;
        switch (type) {
          case "textSnippet":
            action = makeAction({ type, payload: { source: "inline", text: "t", pasteMode: "sendText" as PasteMode, tags: [] } });
            break;
          case "sequence":
            action = makeAction({ type, payload: { steps: [] } });
            break;
          case "launch":
            action = makeAction({ type, payload: { target: "x.exe" } });
            break;
          case "menu":
            action = makeAction({ type, payload: { items: [] } });
            break;
          case "mouseAction":
            action = makeAction({ type, payload: { action: "leftClick" } });
            break;
          case "mediaKey":
            action = makeAction({ type, payload: { key: "playPause" } });
            break;
          case "profileSwitch":
            action = makeAction({ type, payload: { targetProfileId: "p1" } });
            break;
          case "disabled":
            action = makeAction({ type, payload: {} });
            break;
        }
        // withShortcutPayload should be a no-op for all non-shortcut types
        expect(withShortcutPayload(action, (p) => ({ ...p, key: "X" }))).toBe(action);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("null & empty: describeActionSummary with empty sequence steps", () => {
  it("sequence with zero steps returns a valid non-empty summary", () => {
    const action = makeAction({ type: "sequence", payload: { steps: [] } });
    const result = describeActionSummary(action, emptySnippets);
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
    // Should mention 0 steps
    expect(result).toContain("0");
  });
});

describe("null & empty: describeActionSummary with empty string profileId", () => {
  it("profileSwitch with empty targetProfileId returns a non-empty summary", () => {
    const action = makeAction({ type: "profileSwitch", payload: { targetProfileId: "" } });
    const result = describeActionSummary(action, emptySnippets);
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

describe("null & empty: describeActionSummary with empty launch target", () => {
  it("launch with empty target returns a non-empty summary without throwing", () => {
    const action = makeAction({ type: "launch", payload: { target: "" } });
    let result: string;
    expect(() => {
      result = describeActionSummary(action, emptySnippets);
    }).not.toThrow();
    expect(result!.trim().length).toBeGreaterThan(0);
  });
});

describe("null & empty: shortcut with empty key and all modifiers false", () => {
  it("describeActionSummary for empty-key shortcut returns a non-empty string", () => {
    const action = makeAction({
      type: "shortcut",
      payload: { key: "", ctrl: false, shift: false, alt: false, win: false },
    });
    const result = describeActionSummary(action, emptySnippets);
    // With empty key and no modifiers: `modifiers.filter(Boolean)` → empty,
    // result is "Шорткат: " — trailing separator only, but the string itself is non-empty.
    expect(typeof result).toBe("string");
    // SMELL: "Шорткат: " with an empty key produces a trailing colon+space — document it.
    expect(result).toContain("Шорткат");
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW (15%)
// ---------------------------------------------------------------------------

describe("overflow: describeActionSummary with 100k-char strings", () => {
  it("100k-char snippet text inline — does not throw", () => {
    const action = makeAction({
      type: "textSnippet",
      payload: { source: "inline", text: "X".repeat(100_000), pasteMode: "clipboardPaste" as PasteMode, tags: [] },
    });
    expect(() => describeActionSummary(action, emptySnippets)).not.toThrow();
  });

  it("100k-char launch target — does not throw and appears in result", () => {
    const huge = "C:\\" + "A".repeat(99_997);
    const action = makeAction({ type: "launch", payload: { target: huge } });
    let result: string;
    expect(() => { result = describeActionSummary(action, emptySnippets); }).not.toThrow();
    expect(result!).toContain("Цель запуска");
  });

  it("100k-char profileId in profileSwitch — does not throw", () => {
    const action = makeAction({ type: "profileSwitch", payload: { targetProfileId: "P".repeat(100_000) } });
    expect(() => describeActionSummary(action, emptySnippets)).not.toThrow();
  });
});

describe("overflow: sequence with 10k steps does not throw", () => {
  it("describeActionSummary with 10000-step sequence is non-empty", () => {
    const steps: SequenceStep[] = Array.from({ length: 10_000 }, () => ({
      type: "send" as const,
      value: "Ctrl+C",
    }));
    const action = makeAction({ type: "sequence", payload: { steps } });
    let result: string;
    expect(() => { result = describeActionSummary(action, emptySnippets); }).not.toThrow();
    expect(result!).toContain("10000");
  });
});

describe("overflow: mouseActionLabel and mediaKeyLabel with unicode input", () => {
  it("mouseActionLabel with emoji input returns undefined (safe fallback)", () => {
    expect(mouseActionLabel("🎮")).toBeUndefined();
  });

  it("mediaKeyLabel with RTL input returns undefined (safe fallback)", () => {
    expect(mediaKeyLabel("مشغل")).toBeUndefined();
  });

  it("mouseActionLabel with 100k-char string does not throw", () => {
    expect(() => mouseActionLabel("X".repeat(100_000))).not.toThrow();
  });
});

describe("overflow: withShortcutPayload with 100k-char key", () => {
  it("does not throw and preserves the huge key in the payload", () => {
    const hugeKey = "K".repeat(100_000);
    const action = makeAction({
      type: "shortcut",
      payload: { key: "A", ctrl: false, shift: false, alt: false, win: false },
    });
    let updated: Action | undefined;
    expect(() => {
      updated = withShortcutPayload(action, (p) => ({ ...p, key: hugeKey }));
    }).not.toThrow();
    expect(updated?.type).toBe("shortcut");
    if (updated && "key" in updated.payload) {
      expect(updated.payload.key).toBe(hugeKey);
    }
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// All functions in action-helpers.ts are pure and synchronous. No shared
// mutable module state. No async or I/O surfaces exist.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL — N/A
// No timestamp or ID generation in action-helpers.ts. IDs are passed in
// from callers; no time-dependent behavior to test here.
// ---------------------------------------------------------------------------
