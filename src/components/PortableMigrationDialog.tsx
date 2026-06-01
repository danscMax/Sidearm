import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "./shared";

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

  return (
    <ModalShell
      onClose={() => {}}
      className="confirm-modal migration-modal"
      dialogRef={dialogRef}
      ariaLabelledby="migration-title"
      escapeEnabled={false}
      dismissOnBackdropClick={false}
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
    </ModalShell>
  );
}
