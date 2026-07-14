import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CommandError } from "../lib/config";
import { translateCommandError } from "../lib/errors";
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
  label: React.ReactNode;
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

/** A small "?" badge that reveals an explanation bubble on hover/focus. Sits
 *  beside a field label to explain a concept (throttle, trigger mode, …).
 *  Keyboard-reachable (tabIndex 0) and CSP-safe — the bubble is pure CSS, no
 *  inline styles or native `title` delay. */
export function HelpTip({ text, className }: { text: string; className?: string }) {
  const badgeRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  // The badge lives inside a scrolling, overflow-clipped editor. A `position:
  // fixed` bubble escapes that clip (its containing block is the modal
  // backdrop, whose backdrop-filter makes it the fixed containing block), so we
  // position it against the viewport by hand and flip above when there's no
  // room below. Coords go through CSSOM (`.style`) — CSP forbids the inline
  // `style` attribute but not scripted CSSOM writes.
  useLayoutEffect(() => {
    if (!open) return;
    const badge = badgeRef.current;
    const bubble = bubbleRef.current;
    if (!badge || !bubble) return;

    const place = () => {
      const b = badge.getBoundingClientRect();
      const bb = bubble.getBoundingClientRect();
      const pad = 8;
      let top = b.bottom + pad;
      if (top + bb.height > window.innerHeight - pad && b.top - pad - bb.height > pad) {
        top = b.top - pad - bb.height;
      }
      const left = Math.max(pad, Math.min(b.left, window.innerWidth - pad - bb.width));
      bubble.style.top = `${Math.round(top)}px`;
      bubble.style.left = `${Math.round(left)}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <span
      ref={badgeRef}
      className={`help-tip${className ? ` ${className}` : ""}`}
      tabIndex={0}
      role="note"
      aria-label={text}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className="help-tip__badge" aria-hidden="true">
        ?
      </span>
      {open ? (
        <span ref={bubbleRef} className="help-tip__bubble" role="tooltip">
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** A status banner (info/warning/ok/error). Owns the shared `notice notice--*`
 *  class; the lead `<strong>` + body stay the caller's `children`. Replaces the
 *  dozen inline `<div className="notice notice--*">` blocks. */
export function Notice({
  variant,
  children,
  className,
  title,
  id,
}: {
  variant: "info" | "warning" | "ok" | "error";
  children?: React.ReactNode;
  className?: string;
  /** Optional native tooltip on the banner. */
  title?: string;
  /** For aria-describedby links from controls the notice explains. */
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`notice notice--${variant}${className ? ` ${className}` : ""}`}
      title={title}
      // Dynamic warnings/errors must reach screen readers (WCAG 4.1.3).
      role={variant === "warning" || variant === "error" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

export function ErrorPanel({ error }: { error: CommandError }) {
  const { t } = useTranslation();
  const translated = translateCommandError(error, t);
  return (
    <Notice variant="error">
      <strong>{translated.title}</strong>
      <p>{translated.message}</p>
      {translated.hint ? <p className="notice__hint">{translated.hint}</p> : null}
      {translated.details?.length ? (
        <ul>
          {translated.details.map((detail) => (
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
  ariaDescribedby?: string;
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
  ariaDescribedby,
  escapeEnabled = true,
  dismissOnBackdropClick = true,
  onKeyDown,
}: ModalShellProps) {
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const ref = dialogRef ?? fallbackRef;
  const handleKeyDown = useModalDismiss(ref, { onClose, escapeEnabled });

  // Restore focus to the element that opened the modal when it unmounts
  // (WCAG 2.4.3) — closing a dialog must not drop focus to <body>. Centralised
  // here so every ModalShell consumer gets it for free. If the opener was
  // removed from the DOM (e.g. a deleted card), .focus() is a harmless no-op.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  return (
    <div className={backdropClassName} onClick={dismissOnBackdropClick ? onClose : undefined}>
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
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
