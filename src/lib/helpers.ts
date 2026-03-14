import type { AppConfig, AppMapping, ControlId, PhysicalControl } from "./config";

/** Look up human-readable button name from its ControlId, falling back to the raw ID. */
export function controlName(controls: readonly PhysicalControl[], id: string): string {
  return controls.find((c) => c.id === id)?.defaultName ?? id;
}

export function resolveInitialProfileId(config: AppConfig): string | null {
  return (
    config.profiles.find((profile) => profile.id === config.settings.fallbackProfileId)?.id ??
    config.profiles[0]?.id ??
    null
  );
}

export function resolveInitialControlId(config: AppConfig): ControlId | null {
  return (
    config.physicalControls.find((control) => control.family === "thumbGrid")?.id ??
    config.physicalControls[0]?.id ??
    null
  );
}


export function sortAppMappings(mappings: AppMapping[]): AppMapping[] {
  return [...mappings].sort(
    (left, right) =>
      right.priority - left.priority || left.exe.localeCompare(right.exe),
  );
}

export function parseCommaSeparatedUniqueValues(value: string): string[] {
  const seen = new Set<string>();

  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag)) {
        return false;
      }

      seen.add(tag);
      return true;
    });
}

export function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}


export function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : undefined;
}
