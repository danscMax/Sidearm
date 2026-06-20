import { useTranslation } from "react-i18next";

/** Read-only input paired with a Record/Cancel toggle button. Shared by the
 *  shortcut-key and signal capture fields. The caller owns capture state. */
export function CaptureRow({
  value,
  placeholder,
  capturing,
  onToggle,
  recordLabel,
}: {
  value: string;
  placeholder: string;
  capturing: boolean;
  onToggle: () => void;
  /** Idle button label; distinguishes co-located capture rows (key vs signal).
   *  Defaults to the generic "Record". */
  recordLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="capture-row">
      <input
        type="text"
        readOnly
        value={value}
        placeholder={placeholder}
        className={capturing ? "capture-active" : ""}
      />
      <button
        type="button"
        className={`action-button${capturing ? " action-button--accent" : ""}`}
        onClick={onToggle}
      >
        {capturing ? t("common.cancel") : (recordLabel ?? t("picker.record"))}
      </button>
    </div>
  );
}
