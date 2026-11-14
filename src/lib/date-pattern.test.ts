import { describe, expect, it } from "vitest";
import { DATE_TOKENS, formatDatePattern, patternOf } from "./date-pattern";

const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const now = new Date(2026, 10, 4, 9, 5, 7);

describe("date patterns (same cases as the Rust test)", () => {
  it("fills every part and keeps other letters", () => {
    expect(formatDatePattern("dd.MM.yyyy", now, months)).toBe("04.11.2026");
    expect(formatDatePattern("d MMMM yyyy", now, months)).toBe("4 ноября 2026");
    expect(formatDatePattern("dd.MM.yy HH:mm:ss", now, months)).toBe("04.11.26 09:05:07");
    expect(formatDatePattern("[ддд]", now, months)).toBe("[ддд]");
  });

  it("knows each offered token's pattern", () => {
    expect(DATE_TOKENS.map((token) => formatDatePattern(patternOf(token), now, months)))
      .toEqual(["2026-11-04", "04.11.2026", "04.11.26", "4 ноября 2026", "09:05", "04.11.2026 09:05"]);
  });
});
