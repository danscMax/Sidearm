import { useRef } from "react";
import type { CommandError } from "../lib/config";
import { useModalDismiss } from "../hooks/useModalDismiss";

export function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={`fact${mono ? " fact--mono" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-switch${disabled ? " toggle-switch--disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        disabled={disabled}
      />
      <span className="toggle-switch__track">
        <span className="toggle-switch__knob">
          <svg className="toggle-switch__icon" viewBox="0 0 12 12" aria-hidden="true">
            {checked ? (
              <polyline points="2.5 6 5 8.5 9.5 3.5" />
            ) : (
              <>
                <line x1="3" y1="3" x2="9" y2="9" />
                <line x1="9" y1="3" x2="3" y2="9" />
              </>
            )}
          </svg>
        </span>
      </span>
    </label>
  );
}

/** Labelled `<select>` wrapped in the shared `field` layout. `options` carry
 *  already-display-ready labels (the caller translates). */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`field${className ? ` ${className}` : ""}`}>
      <span className="field__label">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A status banner (info/warning/ok/error). Owns the shared `notice notice--*`
 *  class; the lead `<strong>` + body stay the caller's `children`. Replaces the
 *  dozen inline `<div className="notice notice--*">` blocks. */
export function Notice({
  variant,
  children,
  className,
}: {
  variant: "info" | "warning" | "ok" | "error";
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`notice notice--${variant}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

export function ErrorPanel({ error }: { error: CommandError }) {
  return (
    <Notice variant="error">
      <strong>{error.code}</strong>
      <p>{error.message}</p>
      {error.details?.length ? (
        <ul>
          {error.details.map((detail) => (
            <li key={detail}>
              <code>{detail}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

/** Shared modal title row: an `<h2>` (+ optional subtitle) and an optional
 *  close button. Always `h2` for consistent heading level / a11y. */
export function ModalHeader({
  title,
  id,
  subtitle,
  onClose,
  closeLabel,
  className,
}: {
  title: React.ReactNode;
  id?: string;
  subtitle?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <header className={`modal-header${className ? ` ${className}` : ""}`}>
      <div className="modal-header__titles">
        <h2 id={id}>{title}</h2>
        {subtitle ? <p className="modal-header__subtitle">{subtitle}</p> : null}
      </div>
      {onClose ? <CloseButton onClick={onClose} ariaLabel={closeLabel ?? ""} /> : null}
    </header>
  );
}

/** Shared modal action row (Cancel / primary / danger buttons). Buttons stay
 *  the caller's children; this only unifies the `<footer>` wrapper that drifted
 *  into five different class names. */
export function ModalFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <footer className={`modal-footer${className ? ` ${className}` : ""}`}>{children}</footer>
  );
}

/** The dismiss "×" button shared by modal headers. */
export function CloseButton({
  onClick,
  ariaLabel,
  className = "rule-modal__close",
}: {
  onClick: () => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <button type="button" className={className} onClick={onClick} aria-label={ariaLabel}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M1 1l12 12M13 1L1 13" />
      </svg>
    </button>
  );
}

interface ModalShellProps {
  onClose: () => void;
  children: React.ReactNode;
  /** className for the dialog element (e.g. "confirm-modal", "action-picker"). */
  className?: string;
  /** className for the backdrop. Default "modal-backdrop"; override for a
   *  full-bleed variant (e.g. the onboarding wizard's "onb-overlay"). */
  backdropClassName?: string;
  /** Pass the caller's ref when it runs its own auto-focus effect on the dialog. */
  dialogRef?: React.RefObject<HTMLDivElement | null>;
  role?: "dialog" | "alertdialog";
  ariaLabel?: string;
  ariaLabelledby?: string;
  /** Escape-to-close gate (forwarded to useModalDismiss). Default true. */
  escapeEnabled?: boolean;
  /** Whether clicking the backdrop closes the modal. Default true. */
  dismissOnBackdropClick?: boolean;
  /** Extra key handler (e.g. arrow-key list nav), run after the focus-trap. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

/**
 * Shared modal scaffold: the `modal-backdrop` + focus-trapped dialog wired to
 * `useModalDismiss` (Escape + Tab cycling). Auto-focusing the initial element
 * stays with the caller (it varies per modal) — pass `dialogRef` so the same
 * node drives both the trap and the caller's focus effect.
 */
export function ModalShell({
  onClose,
  children,
  className,
  backdropClassName = "modal-backdrop",
  dialogRef,
  role = "dialog",
  ariaLabel,
  ariaLabelledby,
  escapeEnabled = true,
  dismissOnBackdropClick = true,
  onKeyDown,
}: ModalShellProps) {
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const ref = dialogRef ?? fallbackRef;
  const handleKeyDown = useModalDismiss(ref, { onClose, escapeEnabled });
  return (
    <div className={backdropClassName} onClick={dismissOnBackdropClick ? onClose : undefined}>
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        tabIndex={-1}
        className={className}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          handleKeyDown(e);
          onKeyDown?.(e);
        }}
      >
        {children}
      </div>
    </div>
  );
}
