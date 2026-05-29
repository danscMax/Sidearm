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

/** Deduplicate strings, dropping empties, preserving first-seen order. */
export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item || seen.has(item)) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

export function parseCommaSeparatedUniqueValues(value: string): string[] {
  return uniqueStrings(value.split(",").map((tag) => tag.trim()));
}

/** Append `item` to `prev`, keeping at most `cap` most-recent elements (FIFO
 *  eviction). Backs the capped in-memory log buffers. */
export function appendToBoundedArray<T>(prev: readonly T[], item: T, cap: number): T[] {
  const next = [...prev, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
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
