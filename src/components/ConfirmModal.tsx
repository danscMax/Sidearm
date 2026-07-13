import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalFooter, ModalHeader, ModalShell } from "./shared";

/* ─────────────────────────────────────────────────────────
   Confirm Modal
   ───────────────────────────────────────────────────────── */

/** The confirmation-modal descriptor App owns and threads to children via
 *  `setConfirmModal`. Single source for every `setConfirmModal` / `showConfirmModal`
 *  prop shape. */
export interface ConfirmModalRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  secondaryConfirmLabel?: string;
  secondaryDanger?: boolean;
  onSecondaryConfirm?: () => void | Promise<void>;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  secondaryConfirmLabel,
  secondaryDanger,
  onSecondaryConfirm,
  onCancel,
}: ConfirmModalRequest & { onCancel: () => void }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [busyAction, setBusyAction] = useState<"primary" | "secondary" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-focus the confirm button on mount so Enter confirms immediately
  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);

  async function handleConfirm(kind: "primary" | "secondary") {
    if (busyAction) return;
    const action = kind === "primary" ? onConfirm : onSecondaryConfirm;
    if (!action) return;
    setBusyAction(kind);
    setActionError(null);
    try {
      await action();
      setBusyAction(null);
      onCancel();
    } catch (unknownError) {
      const message =
        unknownError instanceof Error
          ? unknownError.message
          : typeof unknownError === "string"
          ? unknownError
          : t("errors.unexpected.title");
      setActionError(message);
      setBusyAction(null);
    }
  }

  const isBusy = busyAction !== null;

  return (
    <ModalShell
      onClose={onCancel}
      className="confirm-modal"
      dialogRef={containerRef}
      role={danger ? "alertdialog" : "dialog"}
      ariaLabelledby="confirm-modal-title"
      ariaDescribedby="confirm-modal-message"
    >
      <ModalHeader title={title} id="confirm-modal-title" />
      <div id="confirm-modal-message">{message}</div>
      {actionError ? (
        <p className="panel__muted" role="alert">
          {actionError}
        </p>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="action-button action-button--ghost"
          onClick={onCancel}
          disabled={isBusy}
        >
          {t("common.cancel")}
        </button>
        {onSecondaryConfirm ? (
          <button
            type="button"
            className={`action-button ${secondaryDanger ? "action-button--danger" : "action-button--secondary"}`}
            onClick={() => {
              void handleConfirm("secondary");
            }}
            disabled={isBusy}
          >
            {busyAction === "secondary" ? t("common.processing") : secondaryConfirmLabel ?? t("common.confirm")}
          </button>
        ) : null}
        <button
          ref={confirmButtonRef}
          type="button"
          className={`action-button ${danger ? "action-button--danger" : "action-button--accent"}`}
          onClick={() => {
            void handleConfirm("primary");
          }}
          disabled={isBusy}
        >
          {busyAction === "primary" ? t("common.processing") : confirmLabel ?? t("common.confirm")}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
