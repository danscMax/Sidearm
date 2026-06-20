import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import type { Profile } from "./config";
import { makeAction } from "./test-fixtures";
import {
  autoName,
  buildAction,
  createInitialDrafts,
  isSaveDisabled,
  normalizeKeyName,
  resolveKeyName,
  type PickerDrafts,
} from "./action-picker-helpers";
import { ALL_ACTION_TYPES } from "./constants";

// Identity translate stub — returns the key so a non-empty key always yields a
// non-empty string (matches action-picker-helpers.test.ts).
const t = ((key: string) => key) as unknown as TFunction;

const profiles: Profile[] = [
  { id: "p1", name: "Gaming", enabled: true, priority: 0 },
  { id: "p2", name: "Work", enabled: true, priority: 1 },
];

function makeDrafts(overrides: Partial<PickerDrafts> = {}): PickerDrafts {
  return {
    shortcut: { key: "", ctrl: false, shift: false, alt: false, win: false },
    mouse: { action: "leftClick", ctrl: false, shift: false, alt: false, win: false },
    text: { text: "", pasteMode: "sendText" },
    launch: { target: "", args: [], workingDir: "" },
    media: "playPause",
    profile: "p1",
    sequence: [{ type: "send", value: "Ctrl+C" }],
    menuItems: [],
    name: "",
    conditions: [],
    ...overrides,
  };
}

// Strings that exercise unicode, whitespace, emoji, RTL, BOM and length limits.
const arbEdgyString = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constantFrom("", " ", "\t", "\n", " ", "﻿", "‮", "👨‍👩‍👧‍👦", "ß", "ﬁ"),
  fc.string({ minLength: 1, maxLength: 4 }).map((s) => s.repeat(25000)), // ~100k overflow
);

/* ─────────────────────────────────────────────────────────
   resolveKeyName — boundary (keyCode 124-135 → F13-F24) + no-crash
   ───────────────────────────────────────────────────────── */

function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", code: "", keyCode: 0, ...partial } as KeyboardEvent;
}

describe("boundary: resolveKeyName — keyCode F13-F24 window + total robustness (PBT)", () => {
  it("never throws and always returns a non-empty string for any synthetic event", () => {
    fc.assert(
      fc.property(
        arbEdgyString,
        arbEdgyString,
        fc.integer({ min: -10, max: 300 }),
        (key, code, keyCode) => {
          const out = resolveKeyName(ev({ key, code, keyCode }));
          expect(typeof out).toBe("string");
          expect(out.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("maps keyCode in [124,135] to F13-F24 exactly when key/code are unresolved", () => {
    fc.assert(
      fc.property(fc.integer({ min: 124, max: 135 }), (kc) => {
        expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: kc }))).toBe(
          `F${kc - 111}`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("keyCode just outside [124,135] is NOT an F-key (boundary ±1)", () => {
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 123 }))).toBe("VK_123");
    expect(resolveKeyName(ev({ key: "Unidentified", code: "", keyCode: 136 }))).toBe("VK_136");
  });

  it("a present, identified event.key always wins over fallbacks", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }).filter((k) => k !== "Unidentified"),
        fc.integer({ min: 124, max: 135 }),
        (key, kc) => {
          expect(resolveKeyName(ev({ key, code: "F13", keyCode: kc }))).toBe(key);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/* ─────────────────────────────────────────────────────────
   normalizeKeyName — idempotent + no-crash (null/overflow)
   ───────────────────────────────────────────────────────── */

describe("boundary: normalizeKeyName — idempotence + robustness (PBT)", () => {
  it("is idempotent: normalize(normalize(x)) === normalize(x) for any string", () => {
    fc.assert(
      fc.property(arbEdgyString, (key) => {
        const once = normalizeKeyName(key);
        expect(normalizeKeyName(once)).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws and returns a string for any input incl. huge/unicode", () => {
    fc.assert(
      fc.property(arbEdgyString, (key) => {
        expect(typeof normalizeKeyName(key)).toBe("string");
      }),
      { numRuns: 500 },
    );
  });

  it("multi-char unmapped keys pass through unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 20 }).filter(
          (s) => !([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(s)),
        ),
        (key) => {
          expect(normalizeKeyName(key)).toBe(key);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/* ─────────────────────────────────────────────────────────
   autoName — totality (non-empty for every action type)
   ───────────────────────────────────────────────────────── */

describe("boundary: autoName — totality over all action types (PBT)", () => {
  it("returns a non-empty name for every action type and arbitrary drafts/profiles", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ACTION_TYPES),
        arbEdgyString,
        arbEdgyString,
        fc.boolean(),
        (type, text, target, emptyProfiles) => {
          const drafts = makeDrafts({
            text: { text, pasteMode: "sendText" },
            launch: { target, args: [], workingDir: "" },
          });
          const out = autoName(type, drafts, t, emptyProfiles ? [] : profiles);
          expect(typeof out).toBe("string");
          expect(out.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

/* ─────────────────────────────────────────────────────────
   isSaveDisabled — per-category gate logic + F005 empty-menu boundary
   ───────────────────────────────────────────────────────── */

describe("boundary: isSaveDisabled — gate semantics (PBT)", () => {
  it("shortcut: disabled iff no key AND no modifier", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 5 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (key, ctrl, shift, alt, win) => {
          const drafts = makeDrafts({ shortcut: { key, ctrl, shift, alt, win } });
          const expected = !key && !ctrl && !shift && !alt && !win;
          expect(isSaveDisabled("shortcut", drafts)).toBe(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("menu: disabled exactly at 0 items, enabled at >=1 (F005 boundary)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), (n) => {
        const menuItems = Array.from({ length: n }, (_, i) => ({
          kind: "action" as const,
          id: `m${i}`,
          label: `L${i}`,
          actionId: `a${i}`,
          enabled: true,
        }));
        expect(isSaveDisabled("menu", makeDrafts({ menuItems }))).toBe(n === 0);
      }),
      { numRuns: 200 },
    );
  });

  it("text/launch: disabled iff the relevant field is blank after trim", () => {
    fc.assert(
      fc.property(arbEdgyString, (s) => {
        expect(isSaveDisabled("textSnippet", makeDrafts({ text: { text: s, pasteMode: "sendText" } }))).toBe(
          !s.trim(),
        );
        expect(isSaveDisabled("launch", makeDrafts({ launch: { target: s, args: [], workingDir: "" } }))).toBe(
          !s.trim(),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("unknown categories are never gated (always enabled)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }).filter(
          (c) => !["shortcut", "textSnippet", "launch", "menu"].includes(c),
        ),
        (cat) => {
          expect(isSaveDisabled(cat, makeDrafts())).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/* ─────────────────────────────────────────────────────────
   buildAction — valid shape, id preservation, F039 guard, no-crash
   ───────────────────────────────────────────────────────── */

describe("boundary: buildAction — robustness + invariants (PBT)", () => {
  it("never throws and yields a valid Action shape for any category id", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...ALL_ACTION_TYPES), fc.string({ maxLength: 12 })),
        arbEdgyString,
        (effectiveCategory, name) => {
          const action = buildAction({
            effectiveCategory,
            existingAction: null,
            drafts: makeDrafts({ name }),
            t,
            profiles,
          });
          expect(typeof action.id).toBe("string");
          expect(action.id.length).toBeGreaterThan(0);
          expect(typeof action.type).toBe("string");
          expect(action.payload).toBeDefined();
          expect(typeof action.displayName).toBe("string");
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("preserves the existing action id (deterministic for edited actions)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (id) => {
        const existing = makeAction({
          id,
          type: "shortcut",
          payload: { key: "C", ctrl: false, shift: false, alt: false, win: false },
        });
        const action = buildAction({
          effectiveCategory: "shortcut",
          existingAction: existing,
          drafts: makeDrafts({ shortcut: { key: "C", ctrl: false, shift: false, alt: false, win: false } }),
          t,
          profiles,
        });
        expect(action.id).toBe(id);
      }),
      { numRuns: 500 },
    );
  });

  it("drops blank-value conditions, keeps non-blank (F: condition filtering)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constant("windowTitleContains" as const),
            value: arbEdgyString,
          }),
          { maxLength: 10 },
        ),
        (conditions) => {
          const action = buildAction({
            effectiveCategory: "shortcut",
            existingAction: null,
            drafts: makeDrafts({
              shortcut: { key: "C", ctrl: false, shift: false, alt: false, win: false },
              conditions,
            }),
            t,
            profiles,
          });
          const expectedKept = conditions.filter((c) => c.value.trim()).length;
          if (expectedKept === 0) {
            expect(action.conditions).toBeUndefined();
          } else {
            expect(action.conditions?.length).toBe(expectedKept);
            expect(action.conditions?.every((c) => c.value.trim().length > 0)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("F039: editing a libraryRef snippet with empty draft text keeps the reference", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), arbEdgyString, (snippetId, whitespace) => {
        // Only whitespace-or-empty draft text should preserve the ref.
        fc.pre(whitespace.trim().length === 0);
        const existing = makeAction({
          id: "lib1",
          type: "textSnippet",
          payload: { source: "libraryRef", snippetId },
        });
        const action = buildAction({
          effectiveCategory: "textSnippet",
          existingAction: existing,
          drafts: makeDrafts({ text: { text: whitespace, pasteMode: "sendText" } }),
          t,
          profiles,
        });
        expect(action.type).toBe("textSnippet");
        if (action.type === "textSnippet") {
          expect(action.payload.source).toBe("libraryRef");
          if (action.payload.source === "libraryRef") {
            expect(action.payload.snippetId).toBe(snippetId);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

/* ─────────────────────────────────────────────────────────
   createInitialDrafts — null safety + profile fallback
   ───────────────────────────────────────────────────────── */

describe("null: createInitialDrafts — defaults & no-crash (PBT)", () => {
  it("never throws for null action/binding with any profile list", () => {
    fc.assert(
      fc.property(fc.boolean(), (emptyProfiles) => {
        const drafts = createInitialDrafts(null, null, emptyProfiles ? [] : profiles);
        expect(drafts).toBeDefined();
        expect(typeof drafts.profile).toBe("string");
        // profileSwitch default falls back to first profile id, or "" when none.
        expect(drafts.profile).toBe(emptyProfiles ? "" : "p1");
        expect(drafts.triggerMode).toBe("press");
        expect(Array.isArray(drafts.sequence)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("seeds shortcut payload back from an edited shortcut action (roundtrip)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8 }),
        fc.boolean(),
        fc.boolean(),
        (key, ctrl, shift) => {
          const existing = makeAction({
            type: "shortcut",
            payload: { key, ctrl, shift, alt: false, win: false },
          });
          const drafts = createInitialDrafts(existing, null, profiles);
          expect(drafts.shortcut.key).toBe(key);
          expect(drafts.shortcut.ctrl).toBe(ctrl);
          expect(drafts.shortcut.shift).toBe(shift);
        },
      ),
      { numRuns: 500 },
    );
  });
});
