import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { setKeyRecording } from "../../../lib/backend";

/** Read-only input paired with a Record/Stop toggle button. Shared by the
 *  shortcut-key and signal capture fields. The caller owns capture state.
 *  `captureOnFocus` (keyboard fields): clicking into the field starts the
 *  capture and leaving it stops it — no Record button. */
export function CaptureRow({
  value,
  placeholder,
  capturing,
  onToggle,
  recordLabel,
  ariaLabel,
  captureOnFocus,
}: {
  value: string;
  placeholder: string;
  capturing: boolean;
  onToggle: () => void;
  /** Idle button label; distinguishes co-located capture rows (key vs signal).
   *  Defaults to the generic "Record". */
  recordLabel?: string;
  ariaLabel: string;
  captureOnFocus?: boolean;
}) {
  const { t } = useTranslation();
  // Focus and click arrive together on the first click: read the live state,
  // not this render's, so the second one does not undo the first.
  const live = useRef(capturing);
  live.current = capturing;
  // While recording, the mouse runs nothing in this window and Alt+F4 does
  // not close it, so any combination (closing ones too) can be recorded.
  useEffect(() => {
    if (!capturing) return;
    void setKeyRecording(true).catch(() => {});
    return () => { void setKeyRecording(false).catch(() => {}); };
  }, [capturing]);
  const start = () => {
    if (!live.current) {
      live.current = true;
      onToggle();
    }
  };
  const stop = () => {
    if (live.current) {
      live.current = false;
      onToggle();
    }
  };
  return (
    <div className="capture-row">
      <input
        type="text"
        aria-label={ariaLabel}
        readOnly
        value={value}
        placeholder={placeholder}
        className={`${capturing ? "capture-active" : ""}${captureOnFocus ? " capture-row__input--click" : ""}`}
        onFocus={captureOnFocus ? start : undefined}
        onClick={captureOnFocus ? start : undefined}
        onBlur={captureOnFocus ? stop : undefined}
      />
      {/* While capturing this is "Stop", NOT a second "Cancel" competing with
          the modal footer's, and it stays quiet — accent is reserved for
          confirming CTAs (UI-review V2). */}
      {captureOnFocus ? null : (
        <button type="button" className="action-button" aria-pressed={capturing} onClick={onToggle}>
          {capturing ? t("picker.stopCapture") : (recordLabel ?? t("picker.record"))}
        </button>
      )}
      {/* Announce the capture state to screen readers (UI-review A4). */}
      <span className="sr-only" role="status">
        {capturing ? placeholder : ""}
      </span>
    </div>
  );
}
