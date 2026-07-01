import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalFooter, ModalHeader, ModalShell } from "./shared";
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
  const [copyStatus, setCopyStatus] = useState<"ok" | "failed" | null>(null);
  const [busyAction, setBusyAction] = useState<ErrorActionKind | null>(null);

  useEffect(() => {
    if (error) {
      dialogRef.current?.focus();
      setCopyStatus(null);
      setBusyAction(null);
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
        setCopyStatus("ok");
      } catch {
        setCopyStatus("failed");
      }
      return;
    }
    setBusyAction(action.kind);
    try {
      await onAction?.(action.kind);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <ModalShell
      onClose={onDismiss}
      className="confirm-modal error-modal"
      dialogRef={dialogRef}
      ariaLabelledby="error-modal-title"
    >
        <ModalHeader
          title={translated.title}
          id="error-modal-title"
          className="error-modal__header"
        />

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
          {copyStatus ? (
            <p className="panel__muted">
              {copyStatus === "ok" ? t("errors.copySucceeded") : t("errors.copyFailed")}
            </p>
          ) : null}
        </div>

        <ModalFooter className="error-modal__footer">
          {translated.actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              disabled={busyAction !== null}
              className={
                action.primary
                  ? "action-button action-button--primary"
                  : action.danger
                  ? "action-button action-button--danger"
                  : "action-button action-button--ghost"
              }
              onClick={() => handleAction(action)}
            >
              {busyAction === action.kind ? t("common.processing") : t(action.labelKey)}
            </button>
          ))}
        </ModalFooter>
    </ModalShell>
  );
}
