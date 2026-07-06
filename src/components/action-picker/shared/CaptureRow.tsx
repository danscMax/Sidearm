import { useTranslation } from "react-i18next";

/** Read-only input paired with a Record/Stop toggle button. Shared by the
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
      {/* While capturing this is "Stop", NOT a second "Cancel" competing with
          the modal footer's, and it stays quiet — accent is reserved for
          confirming CTAs (UI-review V2). */}
      <button type="button" className="action-button" aria-pressed={capturing} onClick={onToggle}>
        {capturing ? t("picker.stopCapture") : (recordLabel ?? t("picker.record"))}
      </button>
      {/* Announce the capture state to screen readers (UI-review A4). */}
      <span className="sr-only" role="status">
        {capturing ? placeholder : ""}
      </span>
    </div>
  );
}
