import { useCallback, useEffect } from "react";

interface UseModalDismissOptions {
  /** Called when the user presses Escape (subject to `escapeEnabled`). */
  onClose: () => void;
  /** When false, Escape is ignored — e.g. while a submit is in flight or a
   *  key-capture is active. Defaults to true. */
  escapeEnabled?: boolean;
}

/**
 * Shared modal keyboard behavior: Escape-to-close (via a window listener,
 * guarded by `escapeEnabled`) plus a focus trap that cycles Tab/Shift+Tab
 * within `containerRef`. Returns the `onKeyDown` handler to spread on the modal
 * container.
 *
 * Replaces the bespoke Esc `useEffect` (copied across ~7 modals) and the
 * byte-identical focus-trap callback (previously only in 3 of ~8 modals — the
 * rest now get keyboard containment for free). Auto-focusing the initial
 * element stays per-modal because the target varies (confirm button vs.
 * container vs. search input).
 */
export function useModalDismiss(
  containerRef: React.RefObject<HTMLElement | null>,
  { onClose, escapeEnabled = true }: UseModalDismissOptions,
): (event: React.KeyboardEvent) => void {
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && escapeEnabled) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose, escapeEnabled]);

  return useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const focusable = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [containerRef],
  );
}
