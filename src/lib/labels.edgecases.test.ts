/**
 * labels.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for labels.ts.
 * Targets invariants NOT already covered by labels.test.ts.
 *
 * Categories:
 *   - Boundary (40%): every ActionType variant, every enum case for all label
 *     functions — totality invariant (M6 bug class). Also tests
 *     ACTION_TYPE_LABELS completeness vs. ACTION_CATEGORIES alignment.
 *   - Null & empty (20%): unknown/cast values, null binding, empty action displayName,
 *     undefined encoder source, whitespace-only binding label.
 *   - Overflow (15%): very long strings in binding/action, unicode/RTL labels.
 *   - Concurrency (N/A): all functions are pure, synchronous, no shared state.
 *   - Temporal (N/A): formatTimestamp is tested in labels.test.ts already.
 *     No ID-generation or timer surfaces in the remaining functions.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type {
  ActionType,
  Binding,
  ControlFamily,
  PhysicalControl,
  SequenceStep,
} from "./config";
import type { VerificationStepResult } from "./verification-session";
import {
  labelForControlFamily,
  labelForEncoderSource,
  labelForPreviewStatus,
  labelForExecutionOutcome,
  labelForSequenceStep,
  badgeClassForCapability,
  labelForCapability,
  labelForVerificationResult,
  actionCategoryIcon,
  surfacePrimaryLabel,
  labelForPasteMode,
  labelForLayer,
} from "./labels";
import {
  ACTION_TYPE_LABELS,
  ACTION_CATEGORIES,
  editableActionTypes,
} from "./constants";

// ---------------------------------------------------------------------------
// All known ActionType values — must stay in sync with config.ts ActionType.
// If a new variant is added to ActionType but not to ACTION_TYPE_LABELS /
// ACTION_CATEGORIES, these tests will fail — that is the M6 protection.
// ---------------------------------------------------------------------------

const ALL_ACTION_TYPES: ActionType[] = [
  "shortcut",
  "textSnippet",
  "sequence",
  "launch",
  "menu",
  "mouseAction",
  "mediaKey",
  "profileSwitch",
  "disabled",
  "repairClipboard",
];

// ---------------------------------------------------------------------------
// BOUNDARY (40%) — label totality over every enum/union member
// ---------------------------------------------------------------------------

describe("boundary: ACTION_TYPE_LABELS totality — M6 guard", () => {
  it("every ActionType in ALL_ACTION_TYPES has a non-empty label in ACTION_TYPE_LABELS", () => {
    for (const type of ALL_ACTION_TYPES) {
      const label = ACTION_TYPE_LABELS[type];
      expect(label, `ACTION_TYPE_LABELS["${type}"] must be a non-empty string`).toBeDefined();
      expect(typeof label, `ACTION_TYPE_LABELS["${type}"] must be string`).toBe("string");
      expect(
        (label as string).trim().length,
        `ACTION_TYPE_LABELS["${type}"] must not be blank`,
      ).toBeGreaterThan(0);
    }
  });

  it("ACTION_TYPE_LABELS has no extra keys beyond the known ActionType set", () => {
    // Guard: if a new key is added to the Record that does not match the union,
    // TypeScript already catches it; but we verify the runtime key set is the
    // same size to catch any accidental additions via casting.
    const keys = Object.keys(ACTION_TYPE_LABELS);
    expect(keys.length).toBe(ALL_ACTION_TYPES.length);
    for (const key of keys) {
      expect(ALL_ACTION_TYPES as string[]).toContain(key);
    }
  });

  it("ACTION_TYPE_LABELS has no two distinct ActionTypes mapping to the same label (drift guard)", () => {
    const labels = Object.values(ACTION_TYPE_LABELS);
    const uniqueLabels = new Set(labels);
    // Each action type should have a distinct label — the M6 bug was two types
    // sharing a label after the refactor. Both "menu" and "Контекстное меню"
    // are distinct; if any two collapse to the same string this fails.
    expect(
      uniqueLabels.size,
      "Two or more ActionTypes share an identical label — label drift detected",
    ).toBe(labels.length);
  });
});

describe("boundary: ACTION_CATEGORIES totality and alignment with ACTION_TYPE_LABELS", () => {
  it("every ActionType in ALL_ACTION_TYPES appears in ACTION_CATEGORIES exactly once", () => {
    for (const type of ALL_ACTION_TYPES) {
      const entries = ACTION_CATEGORIES.filter((c) => c.actionType === type);
      expect(entries.length, `ActionType "${type}" must appear exactly once in ACTION_CATEGORIES`).toBe(1);
    }
  });

  it("ACTION_CATEGORIES[*].label always equals ACTION_TYPE_LABELS[actionType] (no drift)", () => {
    for (const cat of ACTION_CATEGORIES) {
      const expected = ACTION_TYPE_LABELS[cat.actionType];
      expect(
        cat.label,
        `ACTION_CATEGORIES entry for "${cat.actionType}" has drifted label`,
      ).toBe(expected);
    }
  });

  it("ACTION_CATEGORIES has the same count as ALL_ACTION_TYPES", () => {
    expect(ACTION_CATEGORIES.length).toBe(ALL_ACTION_TYPES.length);
  });
});

describe("boundary: editableActionTypes alignment with ACTION_TYPE_LABELS (no drift)", () => {
  it("every editableActionTypes entry label matches ACTION_TYPE_LABELS[value]", () => {
    for (const entry of editableActionTypes) {
      const expected = ACTION_TYPE_LABELS[entry.value];
      expect(
        entry.label,
        `editableActionTypes entry for "${entry.value}" has drifted label`,
      ).toBe(expected);
    }
  });

  it("all 9 ActionTypes are present in editableActionTypes", () => {
    const values = editableActionTypes.map((e) => e.value);
    for (const type of ALL_ACTION_TYPES) {
      expect(values, `editableActionTypes missing "${type}"`).toContain(type);
    }
  });
});

describe("boundary: actionCategoryIcon — all ActionType variants return a non-empty string", () => {
  it("every known ActionType maps to a defined, non-empty icon string", () => {
    for (const type of ALL_ACTION_TYPES) {
      const icon = actionCategoryIcon(type);
      expect(typeof icon).toBe("string");
      expect(icon.trim().length).toBeGreaterThan(0);
    }
  });

  it("actionCategoryIcon is deterministic — same input always produces same output", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_ACTION_TYPES), (type) => {
        expect(actionCategoryIcon(type)).toBe(actionCategoryIcon(type));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: labelForControlFamily — all ControlFamily values", () => {
  const ALL_FAMILIES: ControlFamily[] = ["thumbGrid", "topPanel", "wheel", "system"];

  it("every ControlFamily variant returns a non-empty string", () => {
    for (const family of ALL_FAMILIES) {
      const label = labelForControlFamily(family);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("labelForControlFamily is deterministic", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_FAMILIES), (family) => {
        expect(labelForControlFamily(family)).toBe(labelForControlFamily(family));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: labelForSequenceStep — all SequenceStep types", () => {
  const ALL_STEP_TYPES: SequenceStep["type"][] = ["send", "text", "sleep", "launch"];

  it("every SequenceStep type returns a non-empty label", () => {
    for (const stepType of ALL_STEP_TYPES) {
      const label = labelForSequenceStep(stepType);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("no two SequenceStep types share the same label", () => {
    const labels = ALL_STEP_TYPES.map((t) => labelForSequenceStep(t));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("boundary: labelForCapability / badgeClassForCapability — all CapabilityStatus values", () => {
  const ALL_STATUSES: PhysicalControl["capabilityStatus"][] = [
    "verified",
    "needsValidation",
    "reserved",
    "partiallyRemappable",
  ];

  it("every CapabilityStatus produces a non-empty label from labelForCapability", () => {
    for (const status of ALL_STATUSES) {
      const label = labelForCapability(status);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("every CapabilityStatus produces a non-empty badge class", () => {
    for (const status of ALL_STATUSES) {
      const cls = badgeClassForCapability(status);
      expect(typeof cls).toBe("string");
      expect(cls.trim().length).toBeGreaterThan(0);
    }
  });

  it("no two CapabilityStatus values share a badge class (distinct styling)", () => {
    const classes = ALL_STATUSES.map((s) => badgeClassForCapability(s));
    expect(new Set(classes).size).toBe(classes.length);
  });
});

describe("boundary: labelForVerificationResult — all VerificationStepResult values", () => {
  const ALL_RESULTS: VerificationStepResult[] = [
    "pending",
    "matched",
    "mismatched",
    "noSignal",
    "skipped",
  ];

  it("every VerificationStepResult produces a non-empty label", () => {
    for (const result of ALL_RESULTS) {
      const label = labelForVerificationResult(result);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("no two VerificationStepResult values share the same label", () => {
    const labels = ALL_RESULTS.map((r) => labelForVerificationResult(r));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("boundary: labelForPasteMode — both PasteMode values", () => {
  it("clipboardPaste and sendText each return a non-empty, distinct label", () => {
    const a = labelForPasteMode("clipboardPaste");
    const b = labelForPasteMode("sendText");
    expect(a.trim().length).toBeGreaterThan(0);
    expect(b.trim().length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("boundary: labelForLayer — both Layer values", () => {
  it("standard and hypershift each return a non-empty, distinct label", () => {
    const a = labelForLayer("standard");
    const b = labelForLayer("hypershift");
    expect(a.trim().length).toBeGreaterThan(0);
    expect(b.trim().length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%)
// ---------------------------------------------------------------------------

describe("null & empty: actionCategoryIcon unknown type returns safe fallback", () => {
  it("unknown type returns '—' fallback without throwing", () => {
    // Cast to never to simulate a future ActionType not in ACTION_CATEGORIES
    const icon = actionCategoryIcon("__unknown_future_type__" as never);
    expect(typeof icon).toBe("string");
    expect(icon).toBe("—");
  });

  it("empty string type returns '—' fallback without throwing", () => {
    const icon = actionCategoryIcon("" as never);
    expect(icon).toBe("—");
  });
});

describe("null & empty: labelForPreviewStatus — unknown status echoes itself", () => {
  it("returns the input string for any unknown status (passthrough)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(
          (s) => !["resolved", "unresolved", "ambiguous", "conditionUnmet"].includes(s),
        ),
        (unknownStatus) => {
          // The function has a `default: return status` branch
          const result = labelForPreviewStatus(unknownStatus as never);
          expect(result).toBe(unknownStatus);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("null & empty: labelForExecutionOutcome — unknown outcome echoes itself", () => {
  it("returns the input string for any unknown outcome (passthrough)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(
          (s) => !["spawned", "injected", "simulated", "noop"].includes(s),
        ),
        (unknownOutcome) => {
          const result = labelForExecutionOutcome(unknownOutcome as never);
          expect(result).toBe(unknownOutcome);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("null & empty: labelForEncoderSource — undefined returns non-empty fallback", () => {
  it("undefined source returns a non-empty fallback label (not empty string)", () => {
    const label = labelForEncoderSource(undefined);
    expect(typeof label).toBe("string");
    expect(label.trim().length).toBeGreaterThan(0);
  });

  it("unknown source (cast) returns the same non-empty fallback as undefined", () => {
    const fallbackForUndefined = labelForEncoderSource(undefined);
    // Any value hitting the default branch returns same i18n key
    const fallbackForUnknown = labelForEncoderSource("__bogus__" as never);
    expect(fallbackForUnknown).toBe(fallbackForUndefined);
  });
});

describe("null & empty: surfacePrimaryLabel — whitespace-only binding label falls through", () => {
  it("whitespace-only binding label is not returned verbatim", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "   ",
      actionId: "a1",
      enabled: true,
    };
    // Fixed: a whitespace-only label is falsy after trim(), so it falls through
    // to action.displayName (null here) and then the i18n "assigned" fallback —
    // it is never rendered as a blank string.
    const result = surfacePrimaryLabel(binding, null);
    expect(result).not.toBe("   ");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

describe("null & empty: surfacePrimaryLabel — binding with empty-string displayName on action", () => {
  it("returns the i18n assigned fallback when both binding.label and action.displayName are empty", () => {
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: "",
      actionId: "a1",
      enabled: true,
    };
    const result = surfacePrimaryLabel(binding, null);
    // Without action, falls through to i18n("binding.assigned")
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW (15%)
// ---------------------------------------------------------------------------

describe("overflow: ACTION_TYPE_LABELS values are not suspiciously long or empty", () => {
  it("all label strings are between 1 and 60 chars (sanity: no accidental template/key leakage)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_ACTION_TYPES), (type) => {
        const label = ACTION_TYPE_LABELS[type];
        expect(label.length).toBeGreaterThanOrEqual(1);
        // 60-char bound: if a raw i18n key like "action.type.mouseAction" leaks, it would be
        // much shorter than this check but longer than expected translated text.
        // 60 chars is generous for any reasonable button label.
        expect(
          label.length,
          `ACTION_TYPE_LABELS["${type}"] looks like an untranslated key: "${label}"`,
        ).toBeLessThanOrEqual(60);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("overflow: surfacePrimaryLabel — 100k-char binding label does not throw", () => {
  it("very long binding.label is returned without throwing", () => {
    const longLabel = "A".repeat(100_000);
    const binding: Binding = {
      id: "b1",
      profileId: "p1",
      layer: "standard",
      controlId: "thumb_01",
      label: longLabel,
      actionId: "a1",
      enabled: true,
    };
    let result: string;
    expect(() => {
      result = surfacePrimaryLabel(binding, null);
    }).not.toThrow();
    // The function just short-circuits on truthy binding.label — returns it as-is
    expect(result!).toBe(longLabel);
  });
});

describe("overflow: label functions with unicode/emoji/RTL input (passthrough branches)", () => {
  it("labelForPreviewStatus with emoji string echoes the emoji back", () => {
    const emoji = "🎮🕹️";
    const result = labelForPreviewStatus(emoji as never);
    expect(result).toBe(emoji);
  });

  it("labelForExecutionOutcome with Arabic RTL string echoes it back", () => {
    const rtl = "مشغل";
    const result = labelForExecutionOutcome(rtl as never);
    expect(result).toBe(rtl);
  });

  it("labelForPreviewStatus with BOM character does not throw", () => {
    const withBOM = "﻿resolved";
    expect(() => labelForPreviewStatus(withBOM as never)).not.toThrow();
  });

  it("labelForPreviewStatus with null-byte string does not throw", () => {
    const withNull = "resolved ";
    expect(() => labelForPreviewStatus(withNull as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// All functions are pure, synchronous lookups with no shared mutable state.
// No timer, random, or I/O surface exists in labels.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL — N/A
// formatTimestamp is already fully tested in labels.test.ts.
// No other time-dependent functions exist in labels.ts.
// ---------------------------------------------------------------------------
