import { useTranslation } from "react-i18next";
import { CaptureRow } from "./shared/CaptureRow";

export function SignalCaptureField({
  signalDraft,
  onChange,
  isCapturing,
  setIsCapturing,
  expectedSignal,
}: {
  signalDraft: string | null;
  onChange: (value: string | null) => void;
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
        <CaptureRow
          value={signalDraft ?? ""}
          placeholder={isCapturing ? t("picker.signalCapturing") : t("picker.signalEmpty")}
          capturing={isCapturing}
          onToggle={() => setIsCapturing(!isCapturing)}
        />
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
            onClick={() => onChange(expectedSignal)}
          >
            {t("picker.signalApply")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
