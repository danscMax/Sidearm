import { useEffect, type RefObject } from "react";

/**
 * Dismiss a popover (dropdown / context menu) on outside-click or Escape.
 * Shared convention so every popover closes the same way — distinct from
 * `useModalDismiss`, which adds a focus-trap for true modal dialogs.
 *
 * Escape is captured (capture phase + stopPropagation) so the popover closes
 * before any handler behind it reacts to the same key.
 */
export function useDismissable<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [ref, onClose, enabled]);
}
