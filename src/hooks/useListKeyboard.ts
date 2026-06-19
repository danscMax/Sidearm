import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export interface UseListKeyboardOptions {
  /** Number of selectable items in the list. */
  itemCount: number;
  /** Currently highlighted index (read on Enter). */
  activeIndex: number;
  /** Functional state setter for the highlighted index. */
  setActiveIndex: (updater: (prev: number) => number) => void;
  /** Called with the active index when Enter is pressed on a valid row. */
  onSelect: (index: number) => void;
  /** Wrap around the ends (dropdown style) instead of clamping (list/palette style). */
  wrap?: boolean;
}

/**
 * Shared Arrow / Home / End / Enter navigation for a vertical list of options.
 * Returns a key handler that works with both React synthetic and native keyboard
 * events (only `.key` / `.preventDefault` are used), so it can be attached as an
 * `onKeyDown` prop or from a `window` listener. The caller owns the active-index
 * state and its reset policy; this only unifies the key logic that had drifted
 * between ProfileDropdown (wrap) and CommandPalette (clamp).
 */
export function useListKeyboard({
  itemCount,
  activeIndex,
  setActiveIndex,
  onSelect,
  wrap = false,
}: UseListKeyboardOptions) {
  return (event: ReactKeyboardEvent | KeyboardEvent) => {
    if (itemCount === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (wrap ? (i + 1) % itemCount : Math.min(i + 1, itemCount - 1)));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) =>
          wrap ? (i <= 0 ? itemCount - 1 : i - 1) : Math.max(i - 1, 0),
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(() => 0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(() => itemCount - 1);
        break;
      case "Enter":
        if (activeIndex >= 0 && activeIndex < itemCount) {
          event.preventDefault();
          onSelect(activeIndex);
        }
        break;
    }
  };
}
