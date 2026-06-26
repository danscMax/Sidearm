import { useEffect, useRef } from "react";
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
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalRequest & { onCancel: () => void }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the confirm button on mount so Enter confirms immediately
  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);

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
      <p id="confirm-modal-message">{message}</p>
      <ModalFooter>
        <button
          type="button"
          className="action-button action-button--ghost"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          ref={confirmButtonRef}
          type="button"
          className={`action-button ${danger ? "action-button--danger" : "action-button--primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel ?? t("common.confirm")}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
