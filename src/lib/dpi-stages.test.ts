import { describe, expect, it } from "vitest";
import { dpiStageChoices, dpiStagesForValue, normalizeDpiStages } from "./dpi-stages";

describe("profile DPI stage configuration", () => {
  it("validates, sorts, and rejects duplicates or unrepresentable stages", () => {
    expect(normalizeDpiStages([3200, 400, 800], 100, 30000)).toEqual([400, 800, 3200]);
    expect(normalizeDpiStages([400, 400], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([99, 800], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([400, 800.5], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([], 100, 30000)).toBeNull();
    expect(normalizeDpiStages([100, 200, 300, 400, 500, 600], 100, 30000)).toBeNull();
  });
  it("offers defaults plus the saved custom speed without changing configured stages", () => {
    expect(dpiStageChoices(undefined, 1100, 100, 30000)).toEqual([400, 800, 1100, 1600, 3200]);
    const stages = [800, 1100, 1600];
    expect(dpiStageChoices(stages, 1100, 100, 30000)).toEqual(stages);
    expect(stages).toEqual([800, 1100, 1600]);
    expect(dpiStageChoices(undefined, 1100, 1000, 2000)).toEqual([1100, 1600]);
    expect(dpiStageChoices([400, 800, 1100, 1600, 3200], 6000, 100, 30000)).toEqual([400, 800, 1100, 1600, 6000]);
  });
  it("accepts manual values without exceeding five stages or changing unrelated stages", () => {
    expect(dpiStagesForValue([800, 1100, 1600], 1100, 1200, 100, 30000)).toEqual([800, 1100, 1200, 1600]);
    expect(dpiStagesForValue([400, 800, 1100, 1600, 3200], 1100, 1200, 100, 30000)).toEqual([400, 800, 1200, 1600, 3200]);
    expect(dpiStagesForValue([800, 1100, 1600], 1100, 800, 100, 30000)).toEqual([800, 1100, 1600]);
    expect(dpiStagesForValue([800, 1100, 1600], 1100, 99, 100, 30000)).toBeNull();
    expect(dpiStagesForValue([800, 1100, 1600], 1100, 800.5, 100, 30000)).toBeNull();
  });
});
