/**
 * verification-session.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for verification-session.ts.
 * Targets invariants NOT covered by verification-session.test.ts.
 *
 * Coverage categories:
 *   Boundary   (40%) — 0/1/N steps; first/last transitions; index arithmetic
 *   Null/Empty (20%) — null session; empty steps array; null fields
 *   Overflow   (15%) — huge step count; long strings in fields; unicode notes
 *   Concurrency(15%) — N/A: all functions are pure/synchronous with no shared
 *                       mutable state; no async surface exists in this module.
 *   Temporal   (10%) — captureVerificationObservation timestamp guard;
 *                       finalizeVerificationStep sets Date.now() for next step.
 */

import * as fc from "fast-check";
import { describe, it, expect, vi } from "vitest";
import type { VerificationSession, VerificationSessionStep } from "./verification-session";
import type { ControlId, Layer } from "./config";
import type { EncodedKeyEvent, ResolvedInputPreview } from "./runtime";
import {
  activeVerificationStep,
  captureVerificationObservation,
  captureVerificationResolution,
  finalizeVerificationStep,
  navigateToVerificationStep,
  reopenVerificationStep,
  restartVerificationStep,
  summarizeVerificationSession,
  suggestedVerificationStepResult,
  updateVerificationStepNotes,
} from "./verification-session";

// ---------------------------------------------------------------------------
// Minimal builders (no reliance on test-fixtures.ts, independent of config)
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<VerificationSessionStep> = {}): VerificationSessionStep {
  return {
    controlId: "thumb_01",
    controlLabel: "Thumb 1",
    family: "thumbGrid",
    layer: "standard",
    capabilityStatus: "verified",
    expectedEncodedKey: "F13",
    configuredEncodedKey: "F13",
    startedAt: 1000,
    observedEncodedKey: null,
    observedAt: null,
    observedBackend: null,
    activeExe: null,
    activeWindowTitle: null,
    resolutionStatus: null,
    resolvedControlId: null,
    resolvedLayer: null,
    result: "pending",
    notes: "",
    ...overrides,
  };
}

function makeSession(
  steps: VerificationSessionStep[],
  overrides: Partial<VerificationSession> = {},
): VerificationSession {
  return {
    sessionId: "verification-1000",
    scope: "all",
    layer: "standard",
    profileId: "default",
    startedAt: 1000,
    completedAt: null,
    activeStepIndex: 0,
    steps,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EncodedKeyEvent> = {}): EncodedKeyEvent {
  return {
    encodedKey: "F13",
    backend: "test",
    receivedAt: 2000,
    isRepeat: false,
    isKeyUp: false,
    ...overrides,
  };
}

function makePreview(overrides: Partial<ResolvedInputPreview> = {}): ResolvedInputPreview {
  return {
    status: "resolved",
    encodedKey: "F13",
    reason: "matched",
    usedFallbackProfile: false,
    candidateAppMappingIds: [],
    candidateControlIds: ["thumb_01"],
    controlId: "thumb_01",
    layer: "standard",
    ...overrides,
  };
}

// Arbitrary: a non-empty result other than pending
const finalResultArb = fc.constantFrom("matched", "mismatched", "noSignal", "skipped") as fc.Arbitrary<
  "matched" | "mismatched" | "noSignal" | "skipped"
>;

// ---------------------------------------------------------------------------
// BOUNDARY: 0-step session invariants
// ---------------------------------------------------------------------------

describe("boundary — zero-step session", () => {
  it("summarize returns all-zero with empty steps array", () => {
    const session = makeSession([]);
    const s = summarizeVerificationSession(session);
    expect(s.total).toBe(0);
    expect(s.matched + s.mismatched + s.noSignal + s.skipped + s.pending).toBe(0);
  });

  it("activeVerificationStep returns null for empty steps", () => {
    expect(activeVerificationStep(makeSession([]))).toBeNull();
  });

  // BUG CANDIDATE: updateVerificationStepNotes on empty steps passes index 0
  // to updateStep, which does steps[0] = fn(steps[0]) on an undefined slot.
  // The array grows with a hole, but the session shape is mutated in-place
  // via slice + index assignment — verify the function doesn't throw.
  it("updateVerificationStepNotes on empty session does not throw", () => {
    const session = makeSession([]);
    expect(() => updateVerificationStepNotes(session, "note")).not.toThrow();
  });

  // BUG CANDIDATE: restartVerificationStep(session, now) when steps=[] calls
  // updateStep with index 0 → steps[0] = fn(undefined) which spreads undefined.
  it("restartVerificationStep on empty session does not throw", () => {
    const session = makeSession([]);
    expect(() => restartVerificationStep(session, 5000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: single-step session full lifecycle
// ---------------------------------------------------------------------------

describe("boundary — single-step session lifecycle", () => {
  it("after finalizing the only step the session is complete", () => {
    vi.spyOn(Date, "now").mockReturnValue(9000);
    const session = makeSession([makeStep({ startedAt: 1000 })]);
    const done = finalizeVerificationStep(session, "matched", null, null);
    expect(done.completedAt).toBe(9000);
    expect(done.activeStepIndex).toBe(1); // points past end
    vi.restoreAllMocks();
  });

  it("activeStepIndex equals steps.length after completion → activeVerificationStep returns null", () => {
    const session = makeSession(
      [makeStep({ startedAt: 1000 })],
      { activeStepIndex: 1, completedAt: 9000 },
    );
    expect(activeVerificationStep(session)).toBeNull();
  });

  it("navigateToVerificationStep(0) on completed single-step session re-opens", () => {
    vi.spyOn(Date, "now").mockReturnValue(11000);
    const session = makeSession(
      [makeStep({ result: "matched", startedAt: 1000 })],
      { activeStepIndex: 1, completedAt: 9000 },
    );
    const nav = navigateToVerificationStep(session, 0);
    expect(nav.completedAt).toBeNull();
    expect(nav.activeStepIndex).toBe(0);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: last-step / first-step transitions (property-based)
// ---------------------------------------------------------------------------

describe("boundary — last step finalisation never leaves completedAt null", () => {
  it("prop: finalize last step always sets completedAt", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        finalResultArb,
        (n, result) => {
          const steps = Array.from({ length: n }, (_, i) =>
            makeStep({ startedAt: 1000 + i, result: i < n - 1 ? "matched" : "pending" }),
          );
          const session = makeSession(steps, { activeStepIndex: n - 1 });
          vi.spyOn(Date, "now").mockReturnValue(99999);
          const done = finalizeVerificationStep(session, result, null, null);
          vi.restoreAllMocks();
          expect(done.completedAt).not.toBeNull();
          expect(done.activeStepIndex).toBe(n);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("boundary — non-last step finalisation never sets completedAt", () => {
  it("prop: finalizing a non-last step leaves completedAt null", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        finalResultArb,
        (n, result) => {
          const steps = Array.from({ length: n }, (_, i) =>
            makeStep({ startedAt: 1000 + i }),
          );
          // Finalize the first step (not the last)
          const session = makeSession(steps, { activeStepIndex: 0 });
          vi.spyOn(Date, "now").mockReturnValue(50000);
          const next = finalizeVerificationStep(session, result, null, null);
          vi.restoreAllMocks();
          expect(next.completedAt).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: navigateToVerificationStep index bounds (property)
// ---------------------------------------------------------------------------

describe("boundary — navigateToVerificationStep out-of-range is always identity", () => {
  it("prop: any out-of-range index returns the same reference", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.oneof(
          fc.integer({ min: -100, max: -1 }),
          fc.integer({ min: 11, max: 100 }),
        ),
        (n, badIdx) => {
          const steps = Array.from({ length: n }, () => makeStep());
          const session = makeSession(steps, { activeStepIndex: 0 });
          // Adjust badIdx so it is definitely out of range for this n
          const outIdx = badIdx < 0 ? badIdx : badIdx + n;
          const result = navigateToVerificationStep(session, outIdx);
          expect(result).toBe(session);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("prop: exact steps.length is out-of-range (boundary off-by-one)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 15 }), (n) => {
        const steps = Array.from({ length: n }, () => makeStep());
        const session = makeSession(steps);
        const result = navigateToVerificationStep(session, n);
        expect(result).toBe(session);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: reopenVerificationStep index bounds (property)
// ---------------------------------------------------------------------------

describe("boundary — reopenVerificationStep out-of-range is always identity", () => {
  it("prop: out-of-range index returns the same reference", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (n) => {
          const steps = Array.from({ length: n }, () => makeStep({ result: "matched" }));
          const session = makeSession(steps);
          expect(reopenVerificationStep(session, -1)).toBe(session);
          expect(reopenVerificationStep(session, n)).toBe(session);
          expect(reopenVerificationStep(session, n + 999)).toBe(session);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: summarize counts add up to total (property)
// ---------------------------------------------------------------------------

describe("boundary — summarize count invariant", () => {
  it("prop: matched+mismatched+noSignal+skipped+pending always equals total", () => {
    const resultArb = fc.constantFrom(
      "pending", "matched", "mismatched", "noSignal", "skipped",
    ) as fc.Arbitrary<VerificationSessionStep["result"]>;

    fc.assert(
      fc.property(fc.array(resultArb, { minLength: 0, maxLength: 50 }), (results) => {
        const steps = results.map((r) => makeStep({ result: r }));
        const session = makeSession(steps);
        const s = summarizeVerificationSession(session);
        expect(s.total).toBe(results.length);
        expect(s.matched + s.mismatched + s.noSignal + s.skipped + s.pending).toBe(
          results.length,
        );
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: captureVerificationObservation timestamp guard
// ---------------------------------------------------------------------------

describe("temporal — captureVerificationObservation timestamp gate", () => {
  it("prop: event received strictly before startedAt → session unchanged (ref eq)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 1, max: 99 }),
        (startedAt, offset) => {
          const session = makeSession([makeStep({ startedAt })]);
          const event = makeEvent({ receivedAt: startedAt - offset });
          expect(captureVerificationObservation(session, event)).toBe(session);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("prop: event received at or after startedAt → observation is recorded", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (startedAt, offset, encodedKey) => {
          const session = makeSession([makeStep({ startedAt, result: "pending" })]);
          const event = makeEvent({ receivedAt: startedAt + offset, encodedKey });
          const updated = captureVerificationObservation(session, event);
          expect(updated.steps[0].observedEncodedKey).toBe(encodedKey);
          expect(updated.steps[0].observedAt).toBe(startedAt + offset);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: captureVerificationResolution guards
// ---------------------------------------------------------------------------

describe("null/empty — captureVerificationResolution guards", () => {
  it("returns session unchanged when step has no startedAt", () => {
    const session = makeSession([makeStep({ startedAt: null })]);
    const preview = makePreview();
    expect(captureVerificationResolution(session, preview)).toBe(session);
  });

  it("returns session unchanged when step result is not pending", () => {
    const session = makeSession([makeStep({ startedAt: 1000, result: "matched" })]);
    const preview = makePreview();
    expect(captureVerificationResolution(session, preview)).toBe(session);
  });

  it("records resolution when step is active and pending", () => {
    const session = makeSession([makeStep({ startedAt: 1000, result: "pending" })]);
    const preview = makePreview({ status: "resolved", controlId: "thumb_02", layer: "hypershift" });
    const updated = captureVerificationResolution(session, preview);
    expect(updated.steps[0].resolutionStatus).toBe("resolved");
    expect(updated.steps[0].resolvedControlId).toBe("thumb_02");
    expect(updated.steps[0].resolvedLayer).toBe("hypershift");
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: suggestedVerificationStepResult exhaustive-result coverage
// ---------------------------------------------------------------------------

describe("null/empty — suggestedVerificationStepResult with null configuredEncodedKey", () => {
  // The source condition for "matched" requires configuredEncodedKey to be truthy.
  // When configuredEncodedKey is null, even a perfect observation must return mismatched.
  it("no configuredEncodedKey + matching observed → mismatched (not matched)", () => {
    const step = makeStep({
      configuredEncodedKey: null,
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });
    const result = suggestedVerificationStepResult(step, "thumb_01", "standard");
    expect(result).toBe("mismatched");
  });
});

describe("null/empty — suggestedVerificationStepResult livePreview overrides stored fields", () => {
  it("livePreview controlId and layer take precedence over step stored values", () => {
    // Step has stored wrong resolution but livePreview has the correct one.
    const step = makeStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_99" as ControlId, // wrong stored value
      resolvedLayer: "hypershift" as Layer,        // wrong layer
    });
    const livePreview = makePreview({ controlId: "thumb_01", layer: "standard" });
    const result = suggestedVerificationStepResult(step, "thumb_01", "standard", livePreview);
    expect(result).toBe("matched");
  });

  it("livePreview with wrong controlId forces mismatched even if stored values are correct", () => {
    const step = makeStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });
    const livePreview = makePreview({ controlId: "thumb_02", layer: "standard" });
    const result = suggestedVerificationStepResult(step, "thumb_01", "standard", livePreview);
    expect(result).toBe("mismatched");
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: large step count — session stays consistent
// ---------------------------------------------------------------------------

describe("overflow — large step counts", () => {
  it("prop: session with N>>1 steps never gets stuck at unexpected index", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 500 }), (n) => {
        const steps = Array.from({ length: n }, (_, i) =>
          makeStep({ controlId: "thumb_01", startedAt: 1000 + i }),
        );
        const session = makeSession(steps, { activeStepIndex: 0 });
        const active = activeVerificationStep(session);
        expect(active).not.toBeNull();
        expect(active?.startedAt).toBe(1000);

        const summary = summarizeVerificationSession(session);
        expect(summary.total).toBe(n);
        expect(summary.pending).toBe(n);
      }),
      { numRuns: 50 },
    );
  });

  it("prop: navigating to a valid large index is always in range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 50, max: 200 }), (n) => {
        const steps = Array.from({ length: n }, () => makeStep({ result: "matched", startedAt: 1000 }));
        const session = makeSession(steps);
        vi.spyOn(Date, "now").mockReturnValue(99999);
        const last = navigateToVerificationStep(session, n - 1);
        vi.restoreAllMocks();
        expect(last.activeStepIndex).toBe(n - 1);
        const active = activeVerificationStep(last);
        expect(active).not.toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: unicode and long strings in notes / observedEncodedKey
// ---------------------------------------------------------------------------

describe("overflow — unicode and long strings", () => {
  it("prop: updateVerificationStepNotes handles arbitrarily long/unicode notes", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 10_000 }), (note) => {
        const session = makeSession([makeStep()]);
        const updated = updateVerificationStepNotes(session, note);
        expect(updated.steps[0].notes).toBe(note);
      }),
      { numRuns: 200 },
    );
  });

  it("prop: captureVerificationObservation stores any non-empty encodedKey string", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        (key) => {
          const session = makeSession([makeStep({ startedAt: 1000 })]);
          const event = makeEvent({ encodedKey: key, receivedAt: 2000 });
          const updated = captureVerificationObservation(session, event);
          expect(updated.steps[0].observedEncodedKey).toBe(key);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// STATE MACHINE: re-opening a completed session then finalizing re-completes it
// ---------------------------------------------------------------------------

describe("state machine — reopen → re-complete roundtrip", () => {
  it("reopening last step then finalizing re-sets completedAt", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(8000).mockReturnValue(12000);
    const steps = [
      makeStep({ result: "matched", startedAt: 1000 }),
      makeStep({ result: "skipped", startedAt: 2000 }),
    ];
    const session = makeSession(steps, { activeStepIndex: 2, completedAt: 8000 });
    // Reopen last step (index 1)
    const reopened = reopenVerificationStep(session, 1);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.activeStepIndex).toBe(1);
    // Finalize again → should complete again
    const redone = finalizeVerificationStep(reopened, "matched", null, null);
    expect(redone.completedAt).toBe(12000);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// STATE MACHINE: idempotency — notes update is idempotent
// ---------------------------------------------------------------------------

describe("state machine — idempotency", () => {
  it("prop: applying updateVerificationStepNotes twice with same value is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (notes) => {
        const session = makeSession([makeStep()]);
        const once = updateVerificationStepNotes(session, notes);
        const twice = updateVerificationStepNotes(once, notes);
        expect(twice.steps[0].notes).toBe(once.steps[0].notes);
      }),
      { numRuns: 200 },
    );
  });

  it("prop: summarize is idempotent on the same session", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom("pending", "matched", "mismatched", "noSignal", "skipped") as fc.Arbitrary<VerificationSessionStep["result"]>,
          { minLength: 0, maxLength: 20 },
        ),
        (results) => {
          const session = makeSession(results.map((r) => makeStep({ result: r })));
          const s1 = summarizeVerificationSession(session);
          const s2 = summarizeVerificationSession(session);
          expect(s1).toEqual(s2);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// STATE MACHINE: finalizeVerificationStep does not mutate other steps
// ---------------------------------------------------------------------------

describe("state machine — immutability of sibling steps", () => {
  it("prop: finalizing step i never changes result of step j (j != i)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        finalResultArb,
        (n, result) => {
          const steps = Array.from({ length: n }, (_, i) =>
            makeStep({ startedAt: 1000 + i, result: i === 0 ? "pending" : "matched" }),
          );
          const session = makeSession(steps, { activeStepIndex: 0 });
          vi.spyOn(Date, "now").mockReturnValue(50000);
          const after = finalizeVerificationStep(session, result, null, null);
          vi.restoreAllMocks();
          // Step 0 should have the new result, all others must be unchanged
          expect(after.steps[0].result).toBe(result);
          for (let j = 1; j < n; j++) {
            expect(after.steps[j].result).toBe(session.steps[j].result);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// TEMPORAL: finalizeVerificationStep startedAt for the next step
// ---------------------------------------------------------------------------

describe("temporal — finalizeVerificationStep stamps next step startedAt", () => {
  it("the step after the finalized one receives Date.now() as startedAt", () => {
    const STAMP = 77777;
    vi.spyOn(Date, "now").mockReturnValue(STAMP);
    const session = makeSession([
      makeStep({ startedAt: 1000 }),
      makeStep({ startedAt: null }),
    ]);
    const next = finalizeVerificationStep(session, "skipped", null, null);
    expect(next.steps[1].startedAt).toBe(STAMP);
    vi.restoreAllMocks();
  });

  it("prop: next step startedAt is the value returned by Date.now at finalize time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (stamp) => {
        vi.spyOn(Date, "now").mockReturnValue(stamp);
        const session = makeSession([
          makeStep({ startedAt: 1 }),
          makeStep({ startedAt: null }),
        ]);
        const next = finalizeVerificationStep(session, "matched", null, null);
        vi.restoreAllMocks();
        expect(next.steps[1].startedAt).toBe(stamp);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL — suggestedVerificationStepResult: null livePreview falls back to stored
// ---------------------------------------------------------------------------

describe("null — suggestedVerificationStepResult null/undefined livePreview fallback", () => {
  it("undefined livePreview uses stored resolvedControlId/layer", () => {
    const step = makeStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });
    // pass undefined (not passed at all) → should match
    expect(suggestedVerificationStepResult(step, "thumb_01", "standard")).toBe("matched");
  });

  it("null livePreview falls back to stored resolvedControlId/layer", () => {
    const step = makeStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });
    expect(suggestedVerificationStepResult(step, "thumb_01", "standard", null)).toBe("matched");
  });
});
