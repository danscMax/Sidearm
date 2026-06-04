import { useTranslation } from "react-i18next";

export function SignalCaptureField({
  signalDraft,
  setSignalDraft,
  isCapturing,
  setIsCapturing,
  expectedSignal,
}: {
  signalDraft: string | null;
  setSignalDraft: (value: string | null) => void;
  isCapturing: boolean;
  setIsCapturing: (capturing: boolean) => void;
  expectedSignal: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid mt-12">
      <label className="field">
        <span className="field__label">
          {t("picker.signalLabel")}
          {expectedSignal ? (
            <span className="field__hint" title={`${t("picker.signalRecommended")} ${expectedSignal}`}>
              ?
            </span>
          ) : null}
        </span>
        <div className="capture-row">
          <input
            type="text"
            readOnly
            value={signalDraft ?? ""}
            placeholder={isCapturing ? t("picker.signalCapturing") : t("picker.signalEmpty")}
            className={isCapturing ? "capture-active" : ""}
          />
          <button
            type="button"
            className={`action-button${isCapturing ? " action-button--accent" : ""}`}
            onClick={() => setIsCapturing(!isCapturing)}
          >
            {isCapturing ? t("common.cancel") : t("picker.record")}
          </button>
        </div>
        {isCapturing ? (
          <p className="panel__muted">{t("picker.signalCaptureHint")}</p>
        ) : null}
      </label>
      {expectedSignal && signalDraft !== expectedSignal ? (
        <p className="panel__muted">
          {t("picker.signalRecommended")} <code>{expectedSignal}</code>{" "}
          <button
            type="button"
            className="action-button action-button--small action-button--ghost"
            onClick={() => setSignalDraft(expectedSignal)}
          >
            {t("picker.signalApply")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
