import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CommandError } from "../lib/config";
import {
  formatErrorForClipboard,
  translateCommandError,
  type ErrorAction,
  type ErrorActionKind,
} from "../lib/errors";

export interface ErrorModalProps {
  error: CommandError | null;
  onDismiss: () => void;
  onAction?: (kind: ErrorActionKind) => void | Promise<void>;
}

export function ErrorModal({ error, onDismiss, onAction }: ErrorModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!error) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [error, onDismiss]);

  useEffect(() => {
    if (error) {
      dialogRef.current?.focus();
    }
  }, [error]);

  if (!error) return null;

  const translated = translateCommandError(error, t);

  async function handleAction(action: ErrorAction) {
    if (action.kind === "dismiss") {
      onDismiss();
      return;
    }
    if (action.kind === "copyDetails") {
      try {
        await navigator.clipboard.writeText(formatErrorForClipboard(error!));
      } catch {
        // Clipboard not available — ignore silently.
      }
      return;
    }
    await onAction?.(action.kind);
  }

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        ref={dialogRef}
        className="confirm-modal error-modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="error-modal__header">
          <h2>{translated.title}</h2>
        </header>

        <div className="error-modal__body">
          <p className="error-modal__message">{translated.message}</p>
          {translated.hint ? (
            <p className="error-modal__hint">{translated.hint}</p>
          ) : null}

          {translated.details?.length ? (
            <details className="error-modal__details">
              <summary>{t("errors.technicalInfo")}</summary>
              <ul>
                {translated.details.map((detail, i) => (
                  <li key={`${i}-${detail}`}>
                    <code>{detail}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <footer className="error-modal__footer">
          {translated.actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className={
                action.primary
                  ? "action-button action-button--primary"
                  : action.danger
                  ? "action-button action-button--danger"
                  : "action-button action-button--ghost"
              }
              onClick={() => handleAction(action)}
            >
              {t(action.labelKey)}
            </button>
          ))}
        </footer>
      </div>
    </div>
  );
}
