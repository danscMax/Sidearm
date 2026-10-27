/** Profile DPI stages are explicit opt-ins; don't invent the mouse's actual DPI. */
export const DPI_STAGE_PRESETS = [400, 800, 1600, 3200] as const;
export const MAX_DPI_STAGES = 5;

export function normalizeDpiStages(values: readonly number[], min: number, max: number): number[] | null {
  if (values.length < 1 || values.length > MAX_DPI_STAGES
    || values.some((value) => !Number.isInteger(value) || value < min || value > max)) return null;
  const stages = [...new Set(values)].sort((a, b) => a - b);
  return stages.length === values.length ? stages : null;
}

/** Choose a new stage without mutating another profile or selecting a guessed value. */
export function nextAddedDpiStage(stages: readonly number[], min: number, max: number): number | null {
  if (stages.length >= MAX_DPI_STAGES) return null;
  const choices = [400, 800, 1600, 3200, 6400, 12800, 200, 1200, 2400, 4800];
  return choices.find((value) => value >= min && value <= max && !stages.includes(value)) ?? null;
}

/** Replace exactly one stage, rejecting duplicates, out-of-range values and no-ops. */
export function replaceDpiStage(stages: readonly number[], previous: number, next: number, min: number, max: number): number[] | null {
  if (!stages.includes(previous) || previous === next) return null;
  return normalizeDpiStages(stages.map((dpi) => dpi === previous ? next : dpi), min, max);
}
