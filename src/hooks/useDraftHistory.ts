import { useEffect, useRef, useState } from "react";

/** Edits of the same fields closer together than this are one undo step (typing). */
const COALESCE_MS = 800;
const MAX_STEPS = 100;

function changedKeys<T extends object>(before: T, after: T): string {
  return (Object.keys(after) as Array<keyof T>).filter((key) => !Object.is(before[key], after[key])).join(",");
}

/**
 * Undo / redo over a form's drafts: `current` is every draft value (each kept
 * immutable, as React state is), `restore` puts a snapshot back. A change is
 * recorded once React has drawn it; typing in one field in a row is one step.
 */
export function useDraftHistory<T extends object>(current: T, restore: (snapshot: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const last = useRef(current);
  const burst = useRef({ keys: "", at: 0 });
  // Mirrors the stacks' sizes: the buttons read state, never a ref, while drawing.
  const [sizes, setSizes] = useState({ past: 0, future: 0 });
  const sync = () => setSizes({ past: past.current.length, future: future.current.length });

  useEffect(() => {
    const keys = changedKeys(last.current, current);
    if (!keys) return;
    const now = performance.now();
    const sameBurst = keys === burst.current.keys && now - burst.current.at < COALESCE_MS;
    if (!sameBurst) {
      past.current = [...past.current, last.current].slice(-MAX_STEPS);
      future.current = [];
      sync();
    }
    burst.current = { keys, at: now };
    last.current = current;
  });

  function step(from: { current: T[] }, to: { current: T[] }) {
    const snapshot = from.current.at(-1);
    if (!snapshot) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, last.current];
    // Set before React draws it: the restored drafts are no new change.
    last.current = snapshot;
    burst.current = { keys: "", at: 0 };
    restore(snapshot);
    sync();
  }

  return {
    canUndo: sizes.past > 0,
    canRedo: sizes.future > 0,
    undo: () => step(past, future),
    redo: () => step(future, past),
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
