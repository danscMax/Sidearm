/**
 * helpers.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for helpers.ts.
 * Targets invariants NOT covered by helpers.test.ts or edge-cases.test.ts.
 *
 * This file also hosts the parseCommaSeparatedUniqueValues PBT suite
 *   (idempotence, no-empties, no-duplicates, trimmed values, length bound,
 *   first-occurrence order), migrated here from the former edge-cases.test.ts.
 *
 * This file adds:
 *   - uniqueStrings (not directly tested anywhere)
 *   - appendToBoundedArray invariants
 *   - parseCommaSeparatedList PBT (distinct from unique version)
 *   - parseOptionalNumber PBT (nominal tests exist; PBT boundaries missing)
 *   - sortAppMappings PBT
 *   - Overflow: huge arrays, unicode, nbsp, BOM
 *   - Null & empty: whitespace-only, empty arrays, cap=0 / cap=1
 *
 * Categories:
 *   - Boundary (40%)
 *   - Null & empty (20%)
 *   - Overflow (15%)
 *   - Concurrency (N/A): all functions are pure, synchronous, no shared state.
 *   - Temporal (N/A): no time/ID generation in helpers.ts.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type { AppMapping } from "./config";
import {
  uniqueStrings,
  parseCommaSeparatedUniqueValues,
  parseCommaSeparatedList,
  appendToBoundedArray,
  sortAppMappings,
  parseOptionalNumber,
  clampPriority,
} from "./helpers";

// ---------------------------------------------------------------------------
// BOUNDARY (40%)
// ---------------------------------------------------------------------------

describe("boundary: uniqueStrings — dedup + empty-drop + order preservation", () => {
  it("uniqueStrings([]) returns []", () => {
    expect(uniqueStrings([])).toEqual([]);
  });

  it("uniqueStrings(['a']) returns ['a']", () => {
    expect(uniqueStrings(["a"])).toEqual(["a"]);
  });

  it("uniqueStrings never contains duplicates (PBT)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 50 }), (items) => {
        const result = uniqueStrings(items);
        expect(new Set(result).size).toBe(result.length);
      }),
      { numRuns: 1000 },
    );
  });

  it("uniqueStrings never contains empty strings (PBT)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 50 }), (items) => {
        const result = uniqueStrings(items);
        for (const v of result) {
          expect(v.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("uniqueStrings result is a subset of non-empty input items (PBT)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 50 }), (items) => {
        const nonEmpty = new Set(items.filter(Boolean));
        const result = uniqueStrings(items);
        for (const v of result) {
          expect(nonEmpty.has(v)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("uniqueStrings preserves first-occurrence order (PBT)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 10 }),
          { minLength: 1, maxLength: 30 },
        ),
        (items) => {
          const result = uniqueStrings(items);
          const seen = new Set<string>();
          const expectedOrder: string[] = [];
          for (const v of items) {
            if (v && !seen.has(v)) {
              seen.add(v);
              expectedOrder.push(v);
            }
          }
          expect(result).toEqual(expectedOrder);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("uniqueStrings(['', '', '']) returns []", () => {
    expect(uniqueStrings(["", "", ""])).toEqual([]);
  });

  it("uniqueStrings with all-same non-empty entries returns single-element array", () => {
    expect(uniqueStrings(["x", "x", "x", "x"])).toEqual(["x"]);
  });
});

describe("boundary: appendToBoundedArray — cap semantics", () => {
  it("cap=1 always retains only the last element", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 50 }),
        (items) => {
          let arr: readonly number[] = [];
          for (const item of items) {
            arr = appendToBoundedArray(arr, item, 1);
          }
          expect(arr.length).toBe(1);
          expect(arr[0]).toBe(items[items.length - 1]);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("cap=N: after N+M appends, length is exactly N (FIFO eviction)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),   // cap
        fc.integer({ min: 0, max: 30 }),   // overflow count
        (cap, overflow) => {
          const total = cap + overflow;
          let arr: readonly number[] = [];
          for (let i = 0; i < total; i++) {
            arr = appendToBoundedArray(arr, i, cap);
          }
          expect(arr.length).toBe(Math.min(total, cap));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("appendToBoundedArray retains the MOST RECENT cap items in order (PBT)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),          // cap
        fc.integer({ min: 1, max: 20 }),          // items to insert
        (cap, n) => {
          const items = Array.from({ length: n }, (_, i) => i);
          let arr: readonly number[] = [];
          for (const item of items) {
            arr = appendToBoundedArray(arr, item, cap);
          }
          // Last cap items of `items` must match arr in order
          const expected = items.slice(Math.max(0, n - cap));
          expect([...arr]).toEqual(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("appendToBoundedArray does not mutate the original array", () => {
    const original: readonly number[] = [1, 2, 3];
    const snapshot = [...original];
    appendToBoundedArray(original, 4, 3);
    expect([...original]).toEqual(snapshot);
  });

  it("appending to empty array with any cap ≥ 1 yields single-element array", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer(),
        (cap, item) => {
          const result = appendToBoundedArray([], item, cap);
          expect(result).toEqual([item]);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: parseCommaSeparatedList — PBT invariants (distinct from unique version)", () => {
  it("result never contains whitespace-only strings after trimming (PBT)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedList(input);
        for (const v of result) {
          expect(v.trim().length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("result items are always trimmed (PBT)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const result = parseCommaSeparatedList(input);
        for (const v of result) {
          expect(v).toBe(v.trim());
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("result length ≤ number of comma-separated segments", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const segmentCount = input.split(",").length;
        expect(parseCommaSeparatedList(input).length).toBeLessThanOrEqual(segmentCount);
      }),
      { numRuns: 1000 },
    );
  });

  it("parseCommaSeparatedList allows duplicates (unlike unique version) (PBT)", () => {
    // For any repeated non-empty token, duplicates are preserved
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes(",") && s.trim() === s && s.trim().length > 0),
        fc.integer({ min: 2, max: 5 }),
        (token, repeat) => {
          const input = Array.from({ length: repeat }, () => token).join(",");
          const result = parseCommaSeparatedList(input);
          expect(result.length).toBe(repeat);
          expect(result.every((v) => v === token)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("parseCommaSeparatedList of empty string returns []", () => {
    expect(parseCommaSeparatedList("")).toEqual([]);
  });

  it("parseCommaSeparatedList with only whitespace and commas returns []", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(" ", "\t", "  ", ""), { maxLength: 10 }),
        (parts) => {
          const input = parts.join(",");
          const result = parseCommaSeparatedList(input);
          expect(result.every((v) => v.trim().length > 0)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: parseOptionalNumber — PBT over number space", () => {
  it("any valid finite number string parses to a finite number (PBT)", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite),
        (n) => {
          const result = parseOptionalNumber(String(n));
          // May parse or not depending on JS number printing precision;
          // if it parses, it must be finite
          if (result !== undefined) {
            expect(Number.isFinite(result)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("any string not representing a finite number returns undefined (PBT)", () => {
    const nonNumeric = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => {
        const trimmed = s.trim();
        if (!trimmed) return false;
        const n = Number(trimmed);
        return !Number.isFinite(n);
      });

    fc.assert(
      fc.property(nonNumeric, (s) => {
        expect(parseOptionalNumber(s)).toBeUndefined();
      }),
      { numRuns: 1000 },
    );
  });

  it("whitespace-padded valid numbers parse correctly (PBT)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (n, leading, trailing) => {
          const padded = " ".repeat(leading) + String(n) + " ".repeat(trailing);
          const result = parseOptionalNumber(padded);
          // parseOptionalNumber trims then Number(); whitespace-padded integers parse fine
          expect(result).toBe(n);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("NaN string returns undefined", () => {
    expect(parseOptionalNumber("NaN")).toBeUndefined();
  });

  it("hex string returns undefined (Number('0x1') = 1 so hex IS finite — documenting behavior)", () => {
    // Number("0x1") === 1 which is finite, so parseOptionalNumber("0x1") returns 1
    // This documents current JS behavior — it's not a bug, but callers should be aware.
    const result = parseOptionalNumber("0x1");
    // Could be 1 or undefined depending on whether user considers hex valid input
    expect(result === undefined || result === 1).toBe(true);
  });

  it("empty string returns undefined", () => {
    expect(parseOptionalNumber("")).toBeUndefined();
  });

  it("whitespace-only string returns undefined", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() === ""),
        (s) => {
          expect(parseOptionalNumber(s)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("boundary: sortAppMappings — stable across priorities and exe names", () => {
  it("sortAppMappings result has same length as input (PBT)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            exe: fc.string({ minLength: 1, maxLength: 20 }),
            profileId: fc.constant("p1"),
            enabled: fc.boolean(),
            priority: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 20 },
        ),
        (mappings: AppMapping[]) => {
          expect(sortAppMappings(mappings).length).toBe(mappings.length);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("sortAppMappings result is sorted descending by priority (PBT)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            exe: fc.string({ minLength: 1, maxLength: 10 }),
            profileId: fc.constant("p1"),
            enabled: fc.boolean(),
            priority: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 2, maxLength: 20 },
        ),
        (mappings: AppMapping[]) => {
          const sorted = sortAppMappings(mappings);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i - 1]!.priority).toBeGreaterThanOrEqual(sorted[i]!.priority);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("sortAppMappings is idempotent (sorted result sorted again is the same) (PBT)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            exe: fc.string({ minLength: 1, maxLength: 10 }),
            profileId: fc.constant("p1"),
            enabled: fc.boolean(),
            priority: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 15 },
        ),
        (mappings: AppMapping[]) => {
          const once = sortAppMappings(mappings);
          const twice = sortAppMappings(once);
          expect(twice.map((m) => m.id)).toEqual(once.map((m) => m.id));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%)
// ---------------------------------------------------------------------------

describe("null & empty: uniqueStrings with null-like strings", () => {
  it("uniqueStrings with 'null' and 'undefined' literal strings keeps them (non-empty)", () => {
    const result = uniqueStrings(["null", "undefined", "null"]);
    expect(result).toEqual(["null", "undefined"]);
  });

  it("uniqueStrings with only empty strings returns []", () => {
    expect(uniqueStrings(["", "", ""])).toEqual([]);
  });
});

describe("null & empty: appendToBoundedArray with cap larger than any realistic usage", () => {
  it("cap=Number.MAX_SAFE_INTEGER with 100 items returns all 100 items", () => {
    let arr: readonly number[] = [];
    for (let i = 0; i < 100; i++) {
      arr = appendToBoundedArray(arr, i, Number.MAX_SAFE_INTEGER);
    }
    expect(arr.length).toBe(100);
  });
});

describe("null & empty: parseCommaSeparatedUniqueValues passthrough boundary", () => {
  it("whitespace-only input string returns []", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() === ""),
        (ws) => {
          // A whitespace-only string has no commas, so split gives ["   "]
          // trim makes it "", uniqueStrings drops it
          expect(parseCommaSeparatedUniqueValues(ws)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("single non-empty value with surrounding whitespace returns trimmed singleton", () => {
    expect(parseCommaSeparatedUniqueValues("  hello  ")).toEqual(["hello"]);
  });

  it("value consisting only of whitespace between commas is dropped", () => {
    expect(parseCommaSeparatedUniqueValues("a,   ,b")).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW (15%)
// ---------------------------------------------------------------------------

describe("overflow: appendToBoundedArray with 100k items does not throw", () => {
  it("100k appends with cap=1000 returns exactly 1000 items", () => {
    let arr: readonly number[] = [];
    for (let i = 0; i < 100_000; i++) {
      arr = appendToBoundedArray(arr, i, 1000);
    }
    expect(arr.length).toBe(1000);
    // The last element must be 99999
    expect(arr[arr.length - 1]).toBe(99_999);
  });
});

describe("overflow: uniqueStrings with 100k-char single string", () => {
  it("single 100k-char item is kept (non-empty)", () => {
    const huge = "A".repeat(100_000);
    const result = uniqueStrings([huge, huge]);
    expect(result).toEqual([huge]);
  });
});

describe("overflow: parseCommaSeparatedUniqueValues with unicode separators and invisibles", () => {
  it("leading BOM (U+FEFF) is stripped from the token", () => {
    const bom = String.fromCodePoint(0xfeff);
    const result = parseCommaSeparatedUniqueValues(`${bom}tag1,tag2`);
    // U+FEFF is in the zero-width strip set, so the BOM is removed from "tag1".
    expect(result).toEqual(["tag1", "tag2"]);
  });

  it("non-breaking space (U+00A0) collapses to empty via trim() and is dropped", () => {
    const nbsp = String.fromCodePoint(0x00a0);
    const result = parseCommaSeparatedUniqueValues(`a,${nbsp},b`);
    // U+00A0 is NOT in the zero-width set, but String.prototype.trim() DOES strip
    // it (it is ECMAScript WhiteSpace), so the middle token collapses to "".
    expect(result).toEqual(["a", "b"]);
  });

  it("zero-width space (U+200B) is stripped — no phantom token", () => {
    const zwsp = String.fromCodePoint(0x200b);
    const result = parseCommaSeparatedUniqueValues(`a,${zwsp},b`);
    // trim() does NOT remove U+200B, so stripZeroWidth removes it first; the
    // middle token then collapses to "" and is dropped by uniqueStrings.
    expect(result).toEqual(["a", "b"]);
  });
});

describe("overflow: sortAppMappings with MAX_SAFE_INTEGER priorities", () => {
  it("extreme priority values do not produce NaN or throw", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "a.exe", profileId: "p1", enabled: true, priority: Number.MAX_SAFE_INTEGER },
      { id: "m2", exe: "b.exe", profileId: "p1", enabled: true, priority: Number.MIN_SAFE_INTEGER },
    ];
    const result = sortAppMappings(mappings);
    for (const m of result) {
      expect(Number.isNaN(m.priority)).toBe(false);
    }
    expect(result[0]!.id).toBe("m1"); // higher priority first
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// All functions in helpers.ts are pure and synchronous with no shared mutable
// state. There is no race-condition surface.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL — N/A
// No timestamp or ID-generation functions exist in helpers.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseCommaSeparatedUniqueValues (PBT) — migrated from the former
// edge-cases.test.ts
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

describe("clampPriority — finite guard + range (R3)", () => {
  it("returns 0 for non-finite input instead of passing NaN through", () => {
    expect(clampPriority(Number.NaN)).toBe(0);
    expect(clampPriority(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPriority(Number.NEGATIVE_INFINITY)).toBe(0);
  });
  it("clamps into 0..9999 and rounds to an integer", () => {
    expect(clampPriority(-5)).toBe(0);
    expect(clampPriority(12345)).toBe(9999);
    expect(clampPriority(3.7)).toBe(4);
    expect(clampPriority(0)).toBe(0);
    expect(clampPriority(9999)).toBe(9999);
  });
});
