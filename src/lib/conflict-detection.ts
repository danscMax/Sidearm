import type {
  Action,
  AppConfig,
  Binding,
  ControlId,
  Layer,
  ShortcutActionPayload,
} from "./config";

export interface ConflictGroup {
  signature: string;
  profileId: string;
  layer: Layer;
  bindings: Array<{ bindingId: string; controlId: ControlId; label: string }>;
}

/**
 * Pure: find bindings that fire the same shortcut on the same profile+layer.
 * Returns one entry per *group* of conflicting bindings (size ≥ 2). Bindings
 * that are disabled, or whose action is missing/disabled, are ignored.
 *
 * Only shortcut actions are considered — text snippets, sequences, and mouse
 * actions are idiosyncratic and don't conflict in the traditional sense.
 */
export function findShortcutConflicts(config: AppConfig): ConflictGroup[] {
  const actionsById = new Map<string, Action>();
  for (const a of config.actions) actionsById.set(a.id, a);

  // Key: `${profileId}::${layer}::${signature}` → bindings
  const grouped = new Map<string, ConflictGroup>();

  for (const binding of config.bindings) {
    if (!binding.enabled) continue;
    const action = actionsById.get(binding.actionRef);
    if (!action || action.type !== "shortcut") continue;
    const signature = shortcutSignature(action.payload as ShortcutActionPayload);
    if (!signature) continue;

    const key = `${binding.profileId}::${binding.layer}::${signature}`;
    const existing = grouped.get(key);
    const entry = {
      bindingId: binding.id,
      controlId: binding.controlId,
      label: binding.label,
    };
    if (existing) {
      existing.bindings.push(entry);
    } else {
      grouped.set(key, {
        signature,
        profileId: binding.profileId,
        layer: binding.layer,
        bindings: [entry],
      });
    }
  }

  return [...grouped.values()].filter((g) => g.bindings.length > 1);
}

/**
 * Collect binding IDs that participate in *any* conflict, for quick lookup
 * while rendering the mouse visualisation (`Set.has(bindingId)`).
 */
export function conflictingBindingIds(config: AppConfig): Set<string> {
  const ids = new Set<string>();
  for (const group of findShortcutConflicts(config)) {
    for (const b of group.bindings) ids.add(b.bindingId);
  }
  return ids;
}

/** Canonical signature for a shortcut: modifiers (sorted) + key (upper-case). */
export function shortcutSignature(payload: ShortcutActionPayload): string {
  const key = (payload.key ?? "").trim();
  if (!key) return "";
  const mods: string[] = [];
  if (payload.ctrl) mods.push("Ctrl");
  if (payload.shift) mods.push("Shift");
  if (payload.alt) mods.push("Alt");
  if (payload.win) mods.push("Win");
  return `${mods.join("+")}${mods.length ? "+" : ""}${key.toUpperCase()}`;
}

/**
 * Filter: does a binding/action pair match a freeform search query?
 * Matches against label, action.pretty, and the shortcut signature.
 */
export function bindingMatchesQuery(
  binding: Binding | null | undefined,
  action: Action | null | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const parts: string[] = [];
  if (binding) parts.push(binding.label ?? "");
  if (action) {
    parts.push(action.pretty ?? "");
    if (action.type === "shortcut") {
      const sig = shortcutSignature(action.payload as ShortcutActionPayload);
      if (sig) parts.push(sig);
    }
  }
  return parts.some((p) => p.toLowerCase().includes(q));
}
