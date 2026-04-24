import { useEffect } from "react";

export type ToastKind = "info" | "success" | "warning";

export interface ToastState {
  id: number;
  message: string;
  kind?: ToastKind;
}

export interface ToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
  durationMs?: number;
}

export function Toast({ toast, onDismiss, durationMs = 2500 }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [toast?.id, onDismiss, durationMs]);

  if (!toast) return null;

  return (
    <div
      className={`toast toast--${toast.kind ?? "info"}`}
      role="status"
      aria-live="polite"
    >
      {toast.message}
    </div>
  );
}
