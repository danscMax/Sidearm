import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useModalDismiss } from "../hooks/useModalDismiss";

/* ─────────────────────────────────────────────────────────
   Confirm Modal
   ───────────────────────────────────────────────────────── */

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
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

  // Escape-to-close + Tab focus trap (shared modal behavior)
  const handleKeyDown = useModalDismiss(containerRef, { onClose: onCancel });

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="confirm-modal"
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
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
            className="action-button action-button--primary"
            onClick={onConfirm}
          >
            {confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
