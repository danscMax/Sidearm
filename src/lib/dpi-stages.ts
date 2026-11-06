/** Profile DPI stages are explicit opt-ins; don't invent the mouse's actual DPI. */
const DPI_STAGE_PRESETS = [400, 800, 1600, 3200] as const;
const MAX_DPI_STAGES = 5;

export function normalizeDpiStages(values: readonly number[], min: number, max: number): number[] | null {
  if (values.length < 1 || values.length > MAX_DPI_STAGES
    || values.some((value) => !Number.isInteger(value) || value < min || value > max)) return null;
  const stages = [...new Set(values)].sort((a, b) => a - b);
  return stages.length === values.length ? stages : null;
}

/** Display quick choices without persisting anything until the user applies a value. */
export function dpiStageChoices(configured: readonly number[] | undefined, saved: number | undefined, min: number, max: number): number[] {
  const choices = [...new Set(configured ?? DPI_STAGE_PRESETS)]
    .filter((value) => Number.isInteger(value) && value >= min && value <= max)
    .sort((a, b) => a - b).slice(0, MAX_DPI_STAGES);
  if (saved !== undefined && Number.isInteger(saved) && saved >= min && saved <= max && !choices.includes(saved)) {
    if (choices.length === MAX_DPI_STAGES) choices.pop();
    choices.push(saved);
  }
  return choices.sort((a, b) => a - b);
}

/** Manual entry adds a stage; a full list replaces the selected saved stage. */
export function dpiStagesForValue(choices: readonly number[], saved: number | undefined, next: number, min: number, max: number): number[] | null {
  if (choices.includes(next)) return normalizeDpiStages(choices, min, max);
  if (choices.length < MAX_DPI_STAGES) return normalizeDpiStages([...choices, next], min, max);
  const previous = saved !== undefined && choices.includes(saved) ? saved : choices[choices.length - 1];
  return normalizeDpiStages(choices.map((value) => value === previous ? next : value), min, max);
}
