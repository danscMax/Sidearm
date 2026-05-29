import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useModalDismiss } from "../hooks/useModalDismiss";

export interface PortableMigrationDialogProps {
  onChoose: (copyFromRoaming: boolean) => void | Promise<void>;
}

export function PortableMigrationDialog({
  onChoose,
}: PortableMigrationDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Tab focus trap. Escape stays disabled — this one-time prompt requires a
  // deliberate choice, so it must not be dismissable.
  const handleKeyDown = useModalDismiss(dialogRef, {
    onClose: () => {},
    escapeEnabled: false,
  });

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="confirm-modal migration-modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="migration-title"
        onKeyDown={handleKeyDown}
      >
        <header>
          <h2 id="migration-title">{t("migration.title")}</h2>
        </header>

        <div className="migration-modal__body">
          <p>{t("migration.body")}</p>
          <p className="panel__muted">{t("migration.hint")}</p>
        </div>

        <footer className="migration-modal__footer">
          <button
            type="button"
            className="action-button action-button--primary"
            onClick={() => {
              void onChoose(true);
            }}
          >
            {t("migration.copyFromRoaming")}
          </button>
          <button
            type="button"
            className="action-button action-button--ghost"
            onClick={() => {
              void onChoose(false);
            }}
          >
            {t("migration.startFresh")}
          </button>
        </footer>
      </div>
    </div>
  );
}
