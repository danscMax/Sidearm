import { useTranslation } from "react-i18next";

/** Read-only input paired with a Record/Cancel toggle button. Shared by the
 *  shortcut-key and signal capture fields. The caller owns capture state. */
export function CaptureRow({
  value,
  placeholder,
  capturing,
  onToggle,
}: {
  value: string;
  placeholder: string;
  capturing: boolean;
  onToggle: () => void;
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
        {capturing ? t("common.cancel") : t("picker.record")}
      </button>
    </div>
  );
}
