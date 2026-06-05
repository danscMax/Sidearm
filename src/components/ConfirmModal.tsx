import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "./shared";

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
      ariaLabel={title}
    >
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="confirm-modal__actions">
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
      </div>
    </ModalShell>
  );
}
