import { useEffect } from "react";

type ToastKind = "info" | "success" | "warning";
type ToastAction = { label: string; onClick: () => void };

export interface ToastState {
  id: number;
  message: string;
  kind?: ToastKind;
  action?: ToastAction;
}

export interface ToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
}

function toastDuration(kind: ToastKind | undefined, hasAction: boolean): number {
  if (hasAction) return 0;
  if (kind === "warning") return 5500;
  return 3500;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const durationMs = toast ? toastDuration(toast.kind, !!toast.action) : 3500;

  useEffect(() => {
    if (!toast) return;
    if (toast.action) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [toast, onDismiss, durationMs]);

  if (!toast) return null;

  return (
    <div
      className={`toast toast--${toast.kind ?? "info"}${toast.action ? " toast--with-action" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="toast__message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.action!.onClick();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
