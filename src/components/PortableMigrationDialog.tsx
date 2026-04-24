import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

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
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div
        ref={dialogRef}
        className="modal migration-modal"
        tabIndex={-1}
      >
        <header>
          <h2>{t("migration.title")}</h2>
        </header>

        <div className="migration-modal__body">
          <p>{t("migration.body")}</p>
          <p className="panel__muted">{t("migration.hint")}</p>
        </div>

        <footer className="migration-modal__footer">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              void onChoose(true);
            }}
          >
            {t("migration.copyFromRoaming")}
          </button>
          <button
            type="button"
            className="btn"
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
