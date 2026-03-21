import { describe, it, expect } from "vitest";
import type { AppMapping } from "./config";
import {
  resolveInitialProfileId,
  resolveInitialControlId,
  sortAppMappings,
  parseCommaSeparatedUniqueValues,
  parseCommaSeparatedList,
  parseOptionalNumber,
} from "./helpers";
import { makeConfig } from "./test-fixtures";
import type { PhysicalControl } from "./config";

// ---------------------------------------------------------------------------
// resolveInitialProfileId
// ---------------------------------------------------------------------------

describe("resolveInitialProfileId", () => {
  it("returns the fallback profile id when it exists in profiles", () => {
    const config = makeConfig();
    expect(resolveInitialProfileId(config)).toBe("p1");
  });

  it("falls back to the first profile when fallback id does not match", () => {
    const config = makeConfig({
      settings: {
        fallbackProfileId: "nonexistent",
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
    });
    expect(resolveInitialProfileId(config)).toBe("p1");
  });

  it("returns null when profiles array is empty", () => {
    const config = makeConfig({ profiles: [] });
    expect(resolveInitialProfileId(config)).toBeNull();
  });

  it("returns the first profile id when fallback profile is missing and profiles exist", () => {
    const config = makeConfig({
      settings: {
        fallbackProfileId: "missing",
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
      profiles: [{ id: "only", name: "Only", enabled: true, priority: 0 }],
    });
    expect(resolveInitialProfileId(config)).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// resolveInitialControlId
// ---------------------------------------------------------------------------

describe("resolveInitialControlId", () => {
  it("returns the first thumbGrid control", () => {
    const config = makeConfig();
    expect(resolveInitialControlId(config)).toBe("thumb_01");
  });

  it("returns the first control when no thumbGrid exists", () => {
    const config = makeConfig({
      physicalControls: [
        {
          id: "mouse_4",
          family: "topPanel",
          defaultName: "Mouse 4",
          remappable: true,
          capabilityStatus: "verified",
        },
      ] as PhysicalControl[],
    });
    expect(resolveInitialControlId(config)).toBe("mouse_4");
  });

  it("returns null when controls are empty", () => {
    const config = makeConfig({ physicalControls: [] });
    expect(resolveInitialControlId(config)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sortAppMappings
// ---------------------------------------------------------------------------

describe("sortAppMappings", () => {
  it("sorts by priority descending", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "a.exe", profileId: "p1", enabled: true, priority: 1 },
      { id: "m2", exe: "b.exe", profileId: "p1", enabled: true, priority: 10 },
      { id: "m3", exe: "c.exe", profileId: "p1", enabled: true, priority: 5 },
    ];
    const sorted = sortAppMappings(mappings);
    expect(sorted.map((m) => m.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("uses exe name ascending as tiebreaker", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "zoo.exe", profileId: "p1", enabled: true, priority: 5 },
      { id: "m2", exe: "alpha.exe", profileId: "p1", enabled: true, priority: 5 },
      { id: "m3", exe: "mid.exe", profileId: "p1", enabled: true, priority: 5 },
    ];
    const sorted = sortAppMappings(mappings);
    expect(sorted.map((m) => m.exe)).toEqual(["alpha.exe", "mid.exe", "zoo.exe"]);
  });

  it("does not mutate the original array", () => {
    const mappings: AppMapping[] = [
      { id: "m1", exe: "b.exe", profileId: "p1", enabled: true, priority: 2 },
      { id: "m2", exe: "a.exe", profileId: "p1", enabled: true, priority: 1 },
    ];
    const original = [...mappings];
    sortAppMappings(mappings);
    expect(mappings).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// parseCommaSeparatedUniqueValues
// ---------------------------------------------------------------------------

describe("parseCommaSeparatedUniqueValues", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparatedUniqueValues("one,two,three")).toEqual(["one", "two", "three"]);
  });

  it("removes duplicates", () => {
    expect(parseCommaSeparatedUniqueValues("a, a, b")).toEqual(["a", "b"]);
  });

  it("filters out empty strings", () => {
    expect(parseCommaSeparatedUniqueValues("a,,b")).toEqual(["a", "b"]);
  });

  it("trims whitespace from values", () => {
    expect(parseCommaSeparatedUniqueValues("  x , y , z  ")).toEqual(["x", "y", "z"]);
  });

  it("handles all-empty input", () => {
    expect(parseCommaSeparatedUniqueValues(",,")).toEqual([]);
  });

  it("handles a single empty string", () => {
    expect(parseCommaSeparatedUniqueValues("")).toEqual([]);
  });

  it("preserves order of first appearance for duplicates", () => {
    expect(parseCommaSeparatedUniqueValues("c,b,a,b,c")).toEqual(["c", "b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// parseCommaSeparatedList
// ---------------------------------------------------------------------------

describe("parseCommaSeparatedList", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparatedList("one,two,three")).toEqual(["one", "two", "three"]);
  });

  it("keeps duplicates (unlike unique version)", () => {
    expect(parseCommaSeparatedList("a,a,b")).toEqual(["a", "a", "b"]);
  });

  it("filters out empty strings", () => {
    expect(parseCommaSeparatedList("a,,b")).toEqual(["a", "b"]);
  });

  it("trims whitespace", () => {
    expect(parseCommaSeparatedList("  x , y ")).toEqual(["x", "y"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseCommaSeparatedList("")).toEqual([]);
  });

  it("returns empty array for whitespace-only segments", () => {
    expect(parseCommaSeparatedList(" , , ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOptionalNumber
// ---------------------------------------------------------------------------

describe("parseOptionalNumber", () => {
  it("returns a number for valid numeric strings", () => {
    expect(parseOptionalNumber("42")).toBe(42);
  });

  it("returns undefined for empty string", () => {
    expect(parseOptionalNumber("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseOptionalNumber("   ")).toBeUndefined();
  });

  it("returns undefined for NaN-producing strings", () => {
    expect(parseOptionalNumber("abc")).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    expect(parseOptionalNumber("Infinity")).toBeUndefined();
  });

  it("returns undefined for -Infinity", () => {
    expect(parseOptionalNumber("-Infinity")).toBeUndefined();
  });

  it("handles -0 as a finite number", () => {
    expect(parseOptionalNumber("-0")).toBe(-0);
  });

  it("handles scientific notation", () => {
    expect(parseOptionalNumber("1e3")).toBe(1000);
  });

  it("returns undefined for malformed decimals like 1.5.2", () => {
    expect(parseOptionalNumber("1.5.2")).toBeUndefined();
  });

  it("handles negative numbers", () => {
    expect(parseOptionalNumber("-5")).toBe(-5);
  });

  it("handles floating point numbers", () => {
    expect(parseOptionalNumber("3.14")).toBeCloseTo(3.14);
  });
});
