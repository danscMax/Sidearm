import { describe, expect, it } from "vitest";
import { DPI_STAGE_PRESETS, normalizeDpiStages, nextAddedDpiStage, replaceDpiStage } from "./dpi-stages";

describe("profile DPI stage configuration", () => {
  it("validates, sorts, and rejects duplicates or unrepresentable stages", () => {
    expect(normalizeDpiStages([3200, 400, 800], 100, 30000)).toEqual([400, 800, 3200]);
    expect(normalizeDpiStages([400, 400], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([99, 800], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([400, 800.5], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([100, 200, 300, 400, 500, 600], 100, 30000)).toBeNull();
  });
  it("replaces a selected stage without changing other values", () => {
    expect(replaceDpiStage([400, 800, 1600], 800, 950, 100, 30000)).toEqual([400, 950, 1600]);
    expect(replaceDpiStage([400, 800, 1600], 800, 1600, 100, 30000)).toBeNull();
    expect(replaceDpiStage([400, 800, 1600], 800, 800, 100, 30000)).toBeNull();
    expect(replaceDpiStage([400, 800, 1600], 999, 950, 100, 30000)).toBeNull();
    expect(replaceDpiStage([400, 800, 1600], 800, 30001, 100, 30000)).toBeNull();
  });
  it("adds a distinct stage within the catalog limits", () => {
    expect(nextAddedDpiStage(DPI_STAGE_PRESETS, 100, 30000)).toBe(6400);
    expect(nextAddedDpiStage([400, 800, 1600, 3200, 6400], 100, 30000)).toBeNull();
  });
});
