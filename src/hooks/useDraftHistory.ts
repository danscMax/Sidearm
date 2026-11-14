import { useEffect, useState } from "react";

/** Edits of the same fields closer together than this are one undo step (typing). */
const COALESCE_MS = 800;
const MAX_STEPS = 100;

function changedKeys<T extends object>(before: T, after: T, passive: ReadonlyArray<keyof T>): string {
  return (Object.keys(after) as Array<keyof T>)
    .filter((key) => !passive.includes(key) && !Object.is(before[key], after[key])).join(",");
}

/** The stacks of one history. Held by a parent, it outlives a remount of the
 *  form (the picker's press-pattern tabs). */
export interface DraftHistoryStore<T> {
  past: T[];
  future: T[];
  /** The values as last drawn; null until the first draw. */
  last: T | null;
  burst: { keys: string; at: number };
}

export function createDraftHistoryStore<T>(): DraftHistoryStore<T> {
  return { past: [], future: [], last: null, burst: { keys: "", at: 0 } };
}

/**
 * Undo / redo over a form's drafts: `current` is every draft value (each kept
 * immutable, as React state is), `restore` puts a snapshot back. A change is
 * recorded once React has drawn it; typing in one field in a row is one step
 * (a click is always a step of its own). `passive` keys ride along in the
 * snapshots but are no change of their own; `store` keeps the history across
 * a remount.
 */
export function useDraftHistory<T extends object>(
  current: T,
  restore: (snapshot: T) => void,
  { store, passive = [] }: { store?: DraftHistoryStore<T>; passive?: ReadonlyArray<keyof T> } = {},
) {
  const [ownStore] = useState(createDraftHistoryStore<T>);
  const history = store ?? ownStore;
  // Mirrors the stacks' sizes: the buttons read state, never the store, while drawing.
  const [sizes, setSizes] = useState(() => ({ past: history.past.length, future: history.future.length }));
  const sync = () => setSizes({ past: history.past.length, future: history.future.length });

  useEffect(() => {
    const last = history.last;
    history.last = current;
    if (!last) return;
    const keys = changedKeys(last, current, passive);
    if (!keys) return;
    const now = performance.now();
    // Only typing runs together: a click (add a step, move an item) is a step of its own.
    const typing = document.activeElement?.matches("input, textarea, [contenteditable='true']") ?? false;
    const sameBurst = typing && keys === history.burst.keys && now - history.burst.at < COALESCE_MS;
    if (!sameBurst) {
      history.past = [...history.past, last].slice(-MAX_STEPS);
      history.future = [];
      sync();
    }
    history.burst = { keys, at: now };
  });

  function step(from: "past" | "future", to: "past" | "future") {
    const snapshot = history[from].at(-1);
    if (!snapshot) return;
    history[from] = history[from].slice(0, -1);
    history[to] = [...history[to], history.last ?? current];
    // Set before React draws it: the restored drafts are no new change.
    history.last = snapshot;
    history.burst = { keys: "", at: 0 };
    restore(snapshot);
    sync();
  }

  return {
    canUndo: sizes.past > 0,
    canRedo: sizes.future > 0,
    undo: () => step("past", "future"),
    redo: () => step("future", "past"),
  };
}

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside a text field (which keeps its own undo). */
export function historyKey(event: React.KeyboardEvent): "undo" | "redo" | null {
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return null;
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z" || event.code === "KeyZ") return event.shiftKey ? "redo" : "undo";
  if (key === "y" || event.code === "KeyY") return event.shiftKey ? null : "redo";
  return null;
}
