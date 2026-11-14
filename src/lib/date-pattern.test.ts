import { describe, expect, it } from "vitest";
import { DATE_TOKENS, formatDatePattern, patternOf } from "./date-pattern";
// Shared with the Rust test of input_synthesis::format_date_pattern: both must agree.
import fixture from "../../tools/fixtures/date-patterns.json";

const { year, month, day, hour, minute, second } = fixture.moment;
const now = new Date(year, month - 1, day, hour, minute, second);

describe("date patterns (tools/fixtures/date-patterns.json, same as the Rust test)", () => {
  it.each(fixture.patterns)("fills $pattern", ({ pattern, expected }) => {
    expect(formatDatePattern(pattern, now, fixture.months)).toBe(expected);
  });

  it("knows each offered token's pattern", () => {
    expect([...DATE_TOKENS]).toEqual(fixture.tokens.map((entry) => entry.token));
    for (const { token, expected } of fixture.tokens) {
      expect(formatDatePattern(patternOf(token), now, fixture.months), token).toBe(expected);
    }
  });
});
