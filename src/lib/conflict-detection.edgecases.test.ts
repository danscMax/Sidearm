/**
 * conflict-detection.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for conflict-detection.ts.
 * Targets invariants NOT covered by conflict-detection.test.ts.
 *
 * Coverage categories:
 *   Boundary   (40%) — empty config; 1/2/N bindings; threshold ±1 (size ≥ 2);
 *                       all modifier combinations; key case sensitivity.
 *   Null/Empty (20%) — bindings with empty-string key; no bindings; no actions;
 *                       missing actionId; binding referencing unknown action.
 *   Overflow   (15%) — large number of bindings; many conflicting groups;
 *                       long key strings; unicode keys; 3+ bindings in one group.
 *   Concurrency(15%) — N/A: all functions are pure, synchronous, stateless.
 *   Temporal   (10%) — N/A: no Date.now() / timer usage in this module.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type {
  Action,
  AppConfig,
  Binding,
  ControlId,
  Layer,
  ShortcutActionPayload,
} from "./config";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
  shortcutSignature,
} from "./conflict-detection";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeShortcutAction(
  id: string,
  payload: Partial<ShortcutActionPayload> & { key: string },
): Action {
  return {
    id,
    type: "shortcut",
    displayName: `action-${id}`,
    payload: {
      ctrl: false,
      shift: false,
      alt: false,
      win: false,
      ...payload,
    } as ShortcutActionPayload,
  };
}

function makeBinding(
  id: string,
  opts: {
    profileId?: string;
    layer?: Layer;
    controlId?: ControlId;
    actionId: string;
    enabled?: boolean;
    label?: string;
  },
): Binding {
  return {
    id,
    profileId: opts.profileId ?? "p1",
    layer: opts.layer ?? "standard",
    controlId: (opts.controlId ?? "thumb_01") as ControlId,
    label: opts.label ?? "",
    actionId: opts.actionId,
    enabled: opts.enabled ?? true,
  };
}

function makeConfig(actions: Action[], bindings: Binding[]): AppConfig {
  return {
    version: 2,
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
    profiles: [],
    devices: [],
    physicalControls: [],
    encoderMappings: [],
    appMappings: [],
    bindings,
    actions,
    snippetLibrary: [],
  };
}

// Arbitrary for a valid modifier combination
const modArb = fc.record({
  ctrl:  fc.boolean(),
  shift: fc.boolean(),
  alt:   fc.boolean(),
  win:   fc.boolean(),
});

// Arbitrary for a non-empty key string (printable ASCII, no spaces)
const keyArb = fc.stringMatching(/^[A-Za-z0-9F][A-Za-z0-9]{0,9}$/).filter((s) => s.length > 0);

// ---------------------------------------------------------------------------
// BOUNDARY / CORE INVARIANT: shortcutSignature symmetry
// ---------------------------------------------------------------------------

describe("shortcutSignature — determinism and case-normalisation", () => {
  it("prop: same payload always produces the same signature (deterministic)", () => {
    fc.assert(
      fc.property(
        keyArb,
        modArb,
        (key, mods) => {
          const payload: ShortcutActionPayload = { key, ...mods };
          expect(shortcutSignature(payload)).toBe(shortcutSignature(payload));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("prop: key is uppercased in the signature", () => {
    fc.assert(
      fc.property(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), modArb, (letter, mods) => {
        const lower = letter.toLowerCase();
        const upper = letter.toUpperCase();
        const sigLower = shortcutSignature({ key: lower, ...mods });
        const sigUpper = shortcutSignature({ key: upper, ...mods });
        // Both should produce the same (upper-cased) signature
        expect(sigLower).toBe(sigUpper);
        if (sigLower !== "") {
          expect(sigLower).toContain(upper);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("prop: whitespace-padded keys with same trimmed value produce the same signature", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]+$/),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (key, leadingSpaces, trailingSpaces) => {
          const paddedKey = " ".repeat(leadingSpaces) + key + " ".repeat(trailingSpaces);
          const clean: ShortcutActionPayload = { key, ctrl: false, shift: false, alt: false, win: false };
          const padded: ShortcutActionPayload = { key: paddedKey, ctrl: false, shift: false, alt: false, win: false };
          expect(shortcutSignature(padded)).toBe(shortcutSignature(clean));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("prop: modifier order in signature is always Ctrl→Shift→Alt→Win (canonical)", () => {
    fc.assert(
      fc.property(keyArb, (key) => {
        const allMods: ShortcutActionPayload = { key, ctrl: true, shift: true, alt: true, win: true };
        const sig = shortcutSignature(allMods);
        // Verify canonical order by checking positions
        const ctrlIdx  = sig.indexOf("Ctrl");
        const shiftIdx = sig.indexOf("Shift");
        const altIdx   = sig.indexOf("Alt");
        const winIdx   = sig.indexOf("Win");
        // All must be present and in order
        expect(ctrlIdx).toBeLessThan(shiftIdx);
        expect(shiftIdx).toBeLessThan(altIdx);
        expect(altIdx).toBeLessThan(winIdx);
      }),
      { numRuns: 200 },
    );
  });

  it("empty key after trim returns empty string regardless of modifiers", () => {
    fc.assert(
      fc.property(modArb, (mods) => {
        expect(shortcutSignature({ key: "", ...mods })).toBe("");
        expect(shortcutSignature({ key: "   ", ...mods })).toBe("");
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: findShortcutConflicts — empty / singleton configs
// ---------------------------------------------------------------------------

describe("boundary — findShortcutConflicts with empty/minimal config", () => {
  it("empty actions and bindings → no conflicts", () => {
    const cfg = makeConfig([], []);
    expect(findShortcutConflicts(cfg)).toHaveLength(0);
  });

  it("single binding, single action → no conflict (need ≥2 bindings per group)", () => {
    const actions = [makeShortcutAction("a1", { key: "A", ctrl: true })];
    const bindings = [makeBinding("b1", { actionId: "a1" })];
    expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
  });

  it("two bindings, different profiles → no conflict (profile scope)", () => {
    const actions = [
      makeShortcutAction("a1", { key: "A", ctrl: true }),
      makeShortcutAction("a2", { key: "A", ctrl: true }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", profileId: "p1" }),
      makeBinding("b2", { actionId: "a2", profileId: "p2" }),
    ];
    expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
  });

  it("two bindings, different layers → no conflict (layer scope)", () => {
    const actions = [
      makeShortcutAction("a1", { key: "A", ctrl: true }),
      makeShortcutAction("a2", { key: "A", ctrl: true }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", layer: "standard" }),
      makeBinding("b2", { actionId: "a2", layer: "hypershift" }),
    ];
    expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: size ≥ 2 threshold — exactly 2 conflicts detected
// ---------------------------------------------------------------------------

describe("boundary — size threshold ≥ 2", () => {
  it("exactly 2 bindings with same shortcut on same profile+layer → 1 conflict group of size 2", () => {
    const actions = [
      makeShortcutAction("a1", { key: "B", ctrl: true }),
      makeShortcutAction("a2", { key: "B", ctrl: true }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
      makeBinding("b2", { actionId: "a2", controlId: "thumb_02" }),
    ];
    const groups = findShortcutConflicts(makeConfig(actions, bindings));
    expect(groups).toHaveLength(1);
    expect(groups[0].bindings).toHaveLength(2);
  });

  it("3 bindings with same shortcut → 1 group of size 3", () => {
    const actions = [
      makeShortcutAction("a1", { key: "C", ctrl: true }),
      makeShortcutAction("a2", { key: "C", ctrl: true }),
      makeShortcutAction("a3", { key: "C", ctrl: true }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
      makeBinding("b2", { actionId: "a2", controlId: "thumb_02" }),
      makeBinding("b3", { actionId: "a3", controlId: "thumb_03" }),
    ];
    const groups = findShortcutConflicts(makeConfig(actions, bindings));
    expect(groups).toHaveLength(1);
    expect(groups[0].bindings).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CORE INVARIANT: conflict detection is symmetric
// (conflict(a,b) implies conflict(b,a) — the group contains both)
// ---------------------------------------------------------------------------

describe("invariant — conflict detection symmetry", () => {
  it("prop: if b1 and b2 share a shortcut, both appear in the same conflict group", () => {
    fc.assert(
      fc.property(keyArb, modArb, (key, mods) => {
        const sig = shortcutSignature({ key, ...mods });
        if (!sig) return; // skip empty-key cases
        const actions = [
          makeShortcutAction("a1", { key, ...mods }),
          makeShortcutAction("a2", { key, ...mods }),
        ];
        const bindings = [
          makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
          makeBinding("b2", { actionId: "a2", controlId: "thumb_02" }),
        ];
        const groups = findShortcutConflicts(makeConfig(actions, bindings));
        expect(groups).toHaveLength(1);
        const ids = groups[0].bindings.map((b) => b.bindingId);
        expect(ids).toContain("b1");
        expect(ids).toContain("b2");
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: no self-conflict — a single binding never appears in a group alone
// ---------------------------------------------------------------------------

describe("invariant — no self-conflict (reflexive exclusion)", () => {
  it("prop: a single binding with any shortcut payload never produces a conflict", () => {
    fc.assert(
      fc.property(keyArb, modArb, (key, mods) => {
        const actions = [makeShortcutAction("a1", { key, ...mods })];
        const bindings = [makeBinding("b1", { actionId: "a1" })];
        expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: disabled binding is invisible to conflict detection
// ---------------------------------------------------------------------------

describe("invariant — disabled bindings are excluded", () => {
  it("prop: disabling one of two conflicting bindings removes the conflict", () => {
    fc.assert(
      fc.property(keyArb, modArb, fc.boolean(), (key, mods, whichDisabled) => {
        const sig = shortcutSignature({ key, ...mods });
        if (!sig) return;
        const actions = [
          makeShortcutAction("a1", { key, ...mods }),
          makeShortcutAction("a2", { key, ...mods }),
        ];
        const bindings = [
          makeBinding("b1", { actionId: "a1", enabled: whichDisabled ? false : true }),
          makeBinding("b2", { actionId: "a2", enabled: whichDisabled ? true : false }),
        ];
        // At least one is disabled → no conflict group of size ≥ 2
        expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: binding references unknown action → ignored
// ---------------------------------------------------------------------------

describe("null/empty — binding referencing missing or non-shortcut action", () => {
  it("binding referencing a missing actionId is silently ignored", () => {
    const bindings = [
      makeBinding("b1", { actionId: "nonexistent-action-id" }),
      makeBinding("b2", { actionId: "also-missing" }),
    ];
    // No actions at all — both bindings dangle
    expect(findShortcutConflicts(makeConfig([], bindings))).toHaveLength(0);
  });

  it("binding referencing a text-snippet action is not a conflict candidate", () => {
    const snippetAction: Action = {
      id: "a1",
      type: "textSnippet",
      displayName: "Snippet",
      payload: { source: "inline", text: "hello", pasteMode: "sendText", tags: [] },
    };
    const bindings = [
      makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
      makeBinding("b2", { actionId: "a1", controlId: "thumb_02" }),
    ];
    // textSnippet is not a "shortcut" type → ignored
    expect(findShortcutConflicts(makeConfig([snippetAction], bindings))).toHaveLength(0);
  });

  it("shortcut action with empty key is not a conflict candidate (empty signature)", () => {
    const actions = [
      makeShortcutAction("a1", { key: "" }),
      makeShortcutAction("a2", { key: "" }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
      makeBinding("b2", { actionId: "a2", controlId: "thumb_02" }),
    ];
    // shortcutSignature("") returns "" → filtered out → no conflicts
    expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: large number of unique bindings → no false positives
// ---------------------------------------------------------------------------

describe("overflow — many unique bindings produce no false conflicts", () => {
  it("prop: N bindings each with a distinct key → 0 conflict groups", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 100 }), (n) => {
        // Use F1..F{n} as distinct keys — guaranteed unique
        const actions = Array.from({ length: n }, (_, i) =>
          makeShortcutAction(`a${i}`, { key: `F${i + 1}` }),
        );
        const controlIds: ControlId[] = [
          "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05",
          "thumb_06", "thumb_07", "thumb_08", "thumb_09", "thumb_10",
        ];
        const bindings = actions.map((a, i) =>
          makeBinding(`b${i}`, {
            actionId: a.id,
            controlId: controlIds[i % controlIds.length],
          }),
        );
        expect(findShortcutConflicts(makeConfig(actions, bindings))).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: many conflicting bindings → conflict group has correct size
// ---------------------------------------------------------------------------

describe("overflow — large conflict group completeness", () => {
  it("prop: N bindings all sharing the same shortcut → 1 group of size N", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (n) => {
        // All fire Ctrl+Z
        const actions = Array.from({ length: n }, (_, i) =>
          makeShortcutAction(`a${i}`, { key: "Z", ctrl: true }),
        );
        const controlIds: ControlId[] = [
          "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05",
          "thumb_06", "thumb_07", "thumb_08", "thumb_09", "thumb_10",
          "mouse_4", "mouse_5", "wheel_click", "wheel_up", "wheel_down",
        ];
        const bindings = actions.map((a, i) =>
          makeBinding(`b${i}`, {
            actionId: a.id,
            controlId: controlIds[i % controlIds.length],
          }),
        );
        const groups = findShortcutConflicts(makeConfig(actions, bindings));
        expect(groups).toHaveLength(1);
        expect(groups[0].bindings).toHaveLength(n);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: conflictingBindingIds is consistent with findShortcutConflicts
// ---------------------------------------------------------------------------

describe("invariant — conflictingBindingIds consistency", () => {
  it("prop: ids in conflictingBindingIds are exactly the union of all conflict group bindings", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 5 }),
        (conflicting, unique) => {
          const conflictActions = Array.from({ length: conflicting }, (_, i) =>
            makeShortcutAction(`ca${i}`, { key: "Z", ctrl: true, shift: true }),
          );
          const uniqueActions = Array.from({ length: unique }, (_, i) =>
            makeShortcutAction(`ua${i}`, { key: `F${i + 50}` }),
          );
          const controlIds: ControlId[] = [
            "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05",
            "thumb_06", "thumb_07", "thumb_08", "thumb_09", "thumb_10",
          ];
          const conflictBindings = conflictActions.map((a, i) =>
            makeBinding(`cb${i}`, { actionId: a.id, controlId: controlIds[i % controlIds.length] }),
          );
          const uniqueBindings = uniqueActions.map((a, i) =>
            makeBinding(`ub${i}`, { actionId: a.id, controlId: controlIds[(i + conflicting) % controlIds.length] }),
          );
          const cfg = makeConfig(
            [...conflictActions, ...uniqueActions],
            [...conflictBindings, ...uniqueBindings],
          );
          const groups = findShortcutConflicts(cfg);
          const idsFromGroups = new Set(groups.flatMap((g) => g.bindings.map((b) => b.bindingId)));
          const idsFromHelper = conflictingBindingIds(cfg);
          // Sets must be equal
          expect(idsFromHelper.size).toBe(idsFromGroups.size);
          for (const id of idsFromGroups) {
            expect(idsFromHelper.has(id)).toBe(true);
          }
          // Unique bindings must NOT appear in the conflict set
          for (const b of uniqueBindings) {
            expect(idsFromHelper.has(b.id)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: findShortcutConflicts is deterministic (same config → same result)
// ---------------------------------------------------------------------------

describe("invariant — findShortcutConflicts determinism", () => {
  it("prop: calling twice on the same config produces identical output", () => {
    fc.assert(
      fc.property(keyArb, modArb, (key, mods) => {
        const sig = shortcutSignature({ key, ...mods });
        if (!sig) return;
        const actions = [
          makeShortcutAction("a1", { key, ...mods }),
          makeShortcutAction("a2", { key, ...mods }),
        ];
        const bindings = [
          makeBinding("b1", { actionId: "a1", controlId: "thumb_01" }),
          makeBinding("b2", { actionId: "a2", controlId: "thumb_02" }),
        ];
        const cfg = makeConfig(actions, bindings);
        expect(findShortcutConflicts(cfg)).toEqual(findShortcutConflicts(cfg));
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// INVARIANT: all modifier combinations produce distinct signatures when combined
// ---------------------------------------------------------------------------

describe("invariant — modifier combinations produce correct distinct signatures", () => {
  it("no modifiers produces just the uppercased key", () => {
    expect(shortcutSignature({ key: "a", ctrl: false, shift: false, alt: false, win: false }))
      .toBe("A");
  });

  it("prop: any modifier that is true appears in the signature; false ones do not", () => {
    fc.assert(
      fc.property(keyArb, modArb, (key, mods) => {
        const sig = shortcutSignature({ key, ...mods });
        if (!sig) return;
        if (mods.ctrl)  expect(sig).toContain("Ctrl");
        if (mods.shift) expect(sig).toContain("Shift");
        if (mods.alt)   expect(sig).toContain("Alt");
        if (mods.win)   expect(sig).toContain("Win");
        if (!mods.ctrl)  expect(sig).not.toMatch(/(?<!\w)Ctrl(?!\w)/);
        if (!mods.shift) expect(sig).not.toMatch(/(?<!\w)Shift(?!\w)/);
        if (!mods.alt)   expect(sig).not.toMatch(/(?<!\w)Alt(?!\w)/);
        if (!mods.win)   expect(sig).not.toMatch(/(?<!\w)Win(?!\w)/);
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: bindingMatchesQuery — empty/whitespace/null inputs
// ---------------------------------------------------------------------------

describe("boundary — bindingMatchesQuery edge inputs", () => {
  const b = makeBinding("b1", { actionId: "a1", label: "Copy selection" });
  const a = makeShortcutAction("a1", { key: "C", ctrl: true });

  it("whitespace-only query matches everything (trimmed to empty)", () => {
    expect(bindingMatchesQuery(b, a, "   ")).toBe(true);
  });

  it("null binding with non-empty query matches only via action fields", () => {
    // null binding → no label to match
    expect(bindingMatchesQuery(null, a, "ctrl")).toBe(true); // action.displayName contains Ctrl
    expect(bindingMatchesQuery(null, null, "anything")).toBe(false);
  });

  it("null action with non-empty query matches only via binding label", () => {
    expect(bindingMatchesQuery(b, null, "copy")).toBe(true);
    expect(bindingMatchesQuery(b, null, "ctrl+c")).toBe(false); // no action → sig not checked
  });

  it("undefined binding and action with empty query → matches (universal empty query)", () => {
    expect(bindingMatchesQuery(undefined, undefined, "")).toBe(true);
  });

  it("undefined binding and action with non-empty query → false", () => {
    expect(bindingMatchesQuery(undefined, undefined, "x")).toBe(false);
  });

  it("prop: empty query always returns true regardless of inputs", () => {
    fc.assert(
      fc.property(
        fc.option(fc.constant(b), { nil: null }),
        fc.option(fc.constant(a), { nil: null }),
        (maybeBinding, maybeAction) => {
          expect(bindingMatchesQuery(maybeBinding, maybeAction, "")).toBe(true);
          expect(bindingMatchesQuery(maybeBinding, maybeAction, "  ")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// BOUNDARY: bindingMatchesQuery case-insensitivity
// ---------------------------------------------------------------------------

describe("boundary — bindingMatchesQuery case-insensitive matching", () => {
  it("prop: query matches regardless of case", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("copy", "COPY", "Copy", "cOpY"),
        (q) => {
          const b2 = { ...makeBinding("b1", { actionId: "a1" }), label: "Copy selection" };
          expect(bindingMatchesQuery(b2, null, q)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL/EMPTY: findShortcutConflicts — binding with empty-string label
// ---------------------------------------------------------------------------

describe("null/empty — binding label does not affect conflict detection", () => {
  it("bindings with empty labels still conflict if same shortcut", () => {
    const actions = [
      makeShortcutAction("a1", { key: "D", ctrl: true }),
      makeShortcutAction("a2", { key: "D", ctrl: true }),
    ];
    const bindings = [
      makeBinding("b1", { actionId: "a1", label: "", controlId: "thumb_01" }),
      makeBinding("b2", { actionId: "a2", label: "", controlId: "thumb_02" }),
    ];
    const groups = findShortcutConflicts(makeConfig(actions, bindings));
    expect(groups).toHaveLength(1);
    // Label field in group entries comes from binding.label
    expect(groups[0].bindings[0].label).toBe("");
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW: unicode/long keys in shortcutSignature
// ---------------------------------------------------------------------------

describe("overflow — unicode and long keys in shortcutSignature", () => {
  it("very long key is uppercased and included in signature", () => {
    const longKey = "a".repeat(500);
    const sig = shortcutSignature({ key: longKey, ctrl: true, shift: false, alt: false, win: false });
    expect(sig).toBe("Ctrl+" + "A".repeat(500));
  });

  it("unicode key survives signature round-trip (toUpperCase applied)", () => {
    // Non-ASCII letters with a case-transform (e.g. German ß → ẞ or SS)
    const key = "é";
    const sig = shortcutSignature({ key, ctrl: false, shift: false, alt: false, win: false });
    expect(sig).toBe(key.toUpperCase());
  });
});
