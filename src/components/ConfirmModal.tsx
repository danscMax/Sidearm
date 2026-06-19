import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ModalFooter, ModalHeader, ModalShell } from "./shared";

/* ─────────────────────────────────────────────────────────
   Confirm Modal
   ───────────────────────────────────────────────────────── */

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
      ariaLabelledby="confirm-modal-title"
    >
      <ModalHeader title={title} id="confirm-modal-title" />
      <p>{message}</p>
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
