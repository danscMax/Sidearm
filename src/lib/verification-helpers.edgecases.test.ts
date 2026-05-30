/**
 * verification-helpers.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for verification-helpers.ts.
 * Targets invariants NOT covered by verification-helpers.test.ts.
 *
 * Coverage categories:
 *   Boundary   (40%) — all 6 branches of describeVerificationAlignment;
 *                       dotLabel for all known controls + unknown patterns;
 *                       verificationResultColor exhaustive enumeration.
 *   Null/Empty (20%) — empty/whitespace/null strings in alignment function;
 *                       empty observedEncodedKey cases.
 *   Overflow   (15%) — very long key strings in alignment body text;
 *                       unicode key strings; high-numeric thumb ids.
 *   Concurrency(15%) — N/A: all functions are pure, synchronous, stateless.
 *   Temporal   (10%) — N/A: no Date.now() or timer calls in this module.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type { ControlId } from "./config";
import type { VerificationStepResult } from "./verification-session";
import {
  describeVerificationAlignment,
  describeVerificationSessionSuggestion,
  dotLabel,
  verificationResultColor,
} from "./verification-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// All noticeClass values that describeVerificationAlignment can return
const ALL_NOTICE_CLASSES = new Set([
  "notice--info",
  "notice--warning",
  "notice--ok",
  "notice--subtle",
]);

// All VerificationStepResult values that are NOT "pending"
const NON_PENDING_RESULTS: Exclude<VerificationStepResult, "pending">[] = [
  "matched",
  "mismatched",
  "noSignal",
  "skipped",
];

// A step compatible with describeVerificationSessionSuggestion signature
function makeStepForSuggestion(observedEncodedKey: string | null = null) {
  return {
    controlId: "thumb_01" as ControlId,
    controlLabel: "Thumb 1",
    family: "thumbGrid" as const,
    layer: "standard" as const,
    capabilityStatus: "verified" as const,
    expectedEncodedKey: "F13",
    configuredEncodedKey: "F13",
    startedAt: 1000,
    observedEncodedKey,
    observedAt: observedEncodedKey ? 2000 : null,
    observedBackend: observedEncodedKey ? "test" : null,
    activeExe: null,
    activeWindowTitle: null,
    resolutionStatus: null as null,
    resolvedControlId: null as ControlId | null,
    resolvedLayer: null as null,
    result: "pending" as VerificationStepResult,
    notes: "",
  };
}

// ---------------------------------------------------------------------------
// BOUNDARY: describeVerificationAlignment — all 6 branch transitions
// ---------------------------------------------------------------------------

describe("boundary — describeVerificationAlignment branch coverage", () => {
  // Branch 1: both null → info
  it("both null → info notice", () => {
    const r = describeVerificationAlignment(null, null, null, false);
    expect(r.noticeClass).toBe("notice--info");
    expect(r.title).toBeTruthy();
    expect(r.body).toBeTruthy();
  });

  // Branch 2: expected set, configured null → warning (expected shown in body)
  it("expected set, configured null → warning with expected key in body", () => {
    const r = describeVerificationAlignment("Ctrl+A", null, null, false);
    expect(r.noticeClass).toBe("notice--warning");
    expect(r.body).toContain("Ctrl+A");
  });

  // Branch 3: expected !== configured → warning (both shown)
  it("expected and configured differ → warning with both keys in body", () => {
    const r = describeVerificationAlignment("KEY_A", "KEY_B", null, false);
    expect(r.noticeClass).toBe("notice--warning");
    expect(r.body).toContain("KEY_A");
    expect(r.body).toContain("KEY_B");
  });

  // Branch 4: observed === configured AND observedMatchesSelectedControl → ok
  it("observed === configured and matches control → ok notice", () => {
    const r = describeVerificationAlignment("F1", "F1", "F1", true);
    expect(r.noticeClass).toBe("notice--ok");
  });

  // Branch 5: observed !== configured AND observedMatchesSelectedControl → warning
  it("observed differs from configured, matches control → warning", () => {
    const r = describeVerificationAlignment("F1", "F1", "F2", true);
    expect(r.noticeClass).toBe("notice--warning");
    expect(r.body).toContain("F2");
    expect(r.body).toContain("F1");
  });

  // Branch 6 (fallthrough): configured set, no observation yet → subtle
  it("configured set, observed null → subtle (ready to verify)", () => {
    const r = describeVerificationAlignment("F1", "F1", null, false);
    expect(r.noticeClass).toBe("notice--subtle");
  });

  // Ambiguous combination: observed === configured but flag is false → subtle
  it("observed === configured but observedMatchesSelectedControl=false → subtle (not ok)", () => {
    const r = describeVerificationAlignment("F1", "F1", "F1", false);
    // The ok branch requires observedMatchesSelectedControl = true.
    // Without it, falls through to the next check (observed !== configured?) which
    // is false (F1===F1) with flag=false, so that branch is also skipped.
    // Final fallthrough returns subtle.
    expect(r.noticeClass).toBe("notice--subtle");
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: describeVerificationAlignment output is always well-formed
// ---------------------------------------------------------------------------

describe("boundary — describeVerificationAlignment always returns well-formed object", () => {
  it("prop: any combination of inputs returns a non-empty title, body and known noticeClass", () => {
    const maybeStringArb = fc.option(
      fc.string({ minLength: 1, maxLength: 50 }),
      { nil: null },
    );

    fc.assert(
      fc.property(
        maybeStringArb,
        maybeStringArb,
        maybeStringArb,
        fc.boolean(),
        (expected, configured, observed, flag) => {
          const r = describeVerificationAlignment(expected, configured, observed, flag);
          expect(r.title.length).toBeGreaterThan(0);
          expect(r.body.length).toBeGreaterThan(0);
          expect(ALL_NOTICE_CLASSES.has(r.noticeClass)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: describeVerificationAlignment with whitespace-only strings
// ---------------------------------------------------------------------------

describe("null/empty — whitespace-only strings treated as truthy keys", () => {
  // The function does a simple `if (!expectedEncodedKey && !configuredEncodedKey)` check.
  // A whitespace-only string is truthy, so it's NOT the info branch.
  it("whitespace-only expected, null configured → goes to second branch (not info)", () => {
    const r = describeVerificationAlignment("   ", null, null, false);
    // Should NOT be info (info branch fires only when both are null/empty-string/"")
    // An empty string "" is falsy in JS, but "   " is truthy.
    expect(r.noticeClass).not.toBe("notice--info");
  });

  // BUG CANDIDATE: empty string "" is falsy, so describeVerificationAlignment("", null, null, false)
  // treats expectedEncodedKey as falsy and falls into the `both null` info branch,
  // even though the caller passed a non-null (empty) expected key. This is a subtle
  // semantic inconsistency — null and "" are handled identically.
  it("empty-string expected + null configured → info (same as both-null)", () => {
    const r = describeVerificationAlignment("", null, null, false);
    expect(r.noticeClass).toBe("notice--info");
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: very long key strings appear in body without truncation
// ---------------------------------------------------------------------------

describe("overflow — long key strings are echoed into body text", () => {
  it("very long expectedEncodedKey appears in the warning body", () => {
    const longKey = "Ctrl+".repeat(200) + "A";
    const r = describeVerificationAlignment(longKey, null, null, false);
    expect(r.noticeClass).toBe("notice--warning");
    expect(r.body).toContain(longKey);
  });

  it("very long configuredEncodedKey appears in mismatch warning body", () => {
    const longConfigured = "X".repeat(2000);
    const r = describeVerificationAlignment("other", longConfigured, null, false);
    expect(r.noticeClass).toBe("notice--warning");
    expect(r.body).toContain(longConfigured);
  });

  it("unicode key strings survive alignment description round-trip", () => {
    const unicodeKey = "Ctrl+Shift+\u{1F4A5}\u{1F680}é";
    const r = describeVerificationAlignment(unicodeKey, unicodeKey, unicodeKey, true);
    expect(r.noticeClass).toBe("notice--ok");
    expect(r.body).toContain(unicodeKey);
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: describeVerificationSessionSuggestion — all result branches
// ---------------------------------------------------------------------------

describe("boundary — describeVerificationSessionSuggestion result branches", () => {
  it("matched result embeds observedEncodedKey in returned string", () => {
    const step = makeStepForSuggestion("Ctrl+Z");
    const r = describeVerificationSessionSuggestion("matched", step);
    expect(r).toContain("Ctrl+Z");
  });

  it("mismatched with observed key embeds key in string", () => {
    const step = makeStepForSuggestion("F99");
    const r = describeVerificationSessionSuggestion("mismatched", step);
    expect(r).toContain("F99");
  });

  it("mismatched without observed key returns generic text (no undefined/null in output)", () => {
    const step = makeStepForSuggestion(null);
    const r = describeVerificationSessionSuggestion("mismatched", step);
    expect(r).not.toContain("undefined");
    expect(r).not.toContain("null");
    expect(r.length).toBeGreaterThan(0);
  });

  it("noSignal returns non-empty text", () => {
    expect(describeVerificationSessionSuggestion("noSignal", makeStepForSuggestion()).length).toBeGreaterThan(0);
  });

  it("skipped returns non-empty text", () => {
    expect(describeVerificationSessionSuggestion("skipped", makeStepForSuggestion()).length).toBeGreaterThan(0);
  });

  it("prop: all non-pending result types produce a non-empty string", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_PENDING_RESULTS),
        fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
        (result, key) => {
          const step = makeStepForSuggestion(key);
          const r = describeVerificationSessionSuggestion(result, step);
          expect(typeof r).toBe("string");
          expect(r.length).toBeGreaterThan(0);
          // Must not accidentally leak JS runtime artefacts
          expect(r).not.toContain("[object Object]");
          expect(r).not.toContain("undefined");
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: dotLabel — all documented controls + unknown patterns
// ---------------------------------------------------------------------------

describe("boundary — dotLabel known controls", () => {
  const knownLabels: Record<string, string> = {
    thumb_01: "1", thumb_02: "2", thumb_03: "3", thumb_04: "4",
    thumb_05: "5", thumb_06: "6", thumb_07: "7", thumb_08: "8",
    thumb_09: "9", thumb_10: "10", thumb_11: "11", thumb_12: "12",
    mouse_4: "←", mouse_5: "→",
    wheel_up: "↑", wheel_down: "↓", wheel_click: "⊙",
    top_aux_01: "D+", top_aux_02: "D−",
  };

  for (const [id, expected] of Object.entries(knownLabels)) {
    it(`dotLabel("${id}") === "${expected}"`, () => {
      expect(dotLabel(id)).toBe(expected);
    });
  }

  it("unknown control id returns '?'", () => {
    expect(dotLabel("not_a_real_button")).toBe("?");
  });

  it("empty string returns '?'", () => {
    expect(dotLabel("")).toBe("?");
  });
});

describe("boundary — dotLabel thumb pattern edge cases", () => {
  // The regex is /^thumb_(\d+)$/ — any digit sequence matches.
  it("thumb_ with three digits (thumb_100) returns the numeric part without leading zeros stripped more than once", () => {
    // The regex captures digits and applies .replace(/^0/, "").
    // thumb_100 → "100".replace(/^0/, "") → "100" (no leading zero)
    expect(dotLabel("thumb_100")).toBe("100");
  });

  it("thumb_0 strips leading zero → '0'.replace(/^0/, '') → ''", () => {
    // BUG CANDIDATE: thumb_0 produces an empty string because the regex
    // replaces the single "0" character with "", yielding "".
    // Whether thumb_0 is a valid control is separate — but the label would be empty.
    const label = dotLabel("thumb_0");
    // Document the current behaviour: the leading-zero strip removes the only digit.
    expect(label).toBe(""); // captures current (potentially surprising) behaviour
  });

  it("thumb_ with only leading zeros (thumb_00) strips first zero → '0'", () => {
    // "00".replace(/^0/, "") → "0"
    expect(dotLabel("thumb_00")).toBe("0");
  });

  it("prop: all valid thumb ids produce numeric-looking string labels", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (n) => {
        const id = `thumb_${String(n).padStart(2, "0")}`;
        const label = dotLabel(id);
        expect(label).toBe(String(n)); // leading zero stripped
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: verificationResultColor exhaustive coverage
// ---------------------------------------------------------------------------

describe("boundary — verificationResultColor complete enumeration", () => {
  const ALL_RESULTS: VerificationStepResult[] = [
    "pending", "matched", "mismatched", "noSignal", "skipped",
  ];

  it("prop: every result maps to a non-empty CSS variable string", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_RESULTS), (result) => {
        const color = verificationResultColor(result);
        expect(color).toMatch(/^var\(--/);
        expect(color.endsWith(")")).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("all 5 results produce distinct colours", () => {
    const colors = ALL_RESULTS.map((r) => verificationResultColor(r));
    const unique = new Set(colors);
    expect(unique.size).toBe(ALL_RESULTS.length);
  });

  it("prop: same result always returns same colour string (deterministic)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_RESULTS), (result) => {
        expect(verificationResultColor(result)).toBe(verificationResultColor(result));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: describeVerificationAlignment branch — both empty string ""
// Note: empty string is falsy in JS; same path as both null.
// ---------------------------------------------------------------------------

describe("null/empty — describeVerificationAlignment with empty-string keys", () => {
  it("empty expected and empty configured → info (falsy path)", () => {
    const r = describeVerificationAlignment("", "", null, false);
    // "" is falsy → both falsy → info branch fires
    expect(r.noticeClass).toBe("notice--info");
  });

  it("null expected and empty configured → info (falsy path)", () => {
    const r = describeVerificationAlignment(null, "", null, false);
    expect(r.noticeClass).toBe("notice--info");
  });
});
