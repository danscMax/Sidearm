import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ShortcutActionPayload } from "../../lib/config";
import { normalizeKeyName, resolveKeyName } from "../../lib/action-picker-helpers";
import { Toggle } from "../shared";

export function ShortcutEditor({
  draft,
  onChange,
  isCapturing,
  setIsCapturing,
}: {
  draft: ShortcutActionPayload;
  onChange: (draft: ShortcutActionPayload) => void;
  isCapturing: boolean;
  setIsCapturing: (capturing: boolean) => void;
}) {
  const { t } = useTranslation();

  function handleKeyCapture(event: ReactKeyboardEvent) {
    if (!isCapturing) return;
    event.preventDefault();
    event.stopPropagation();

    const key = resolveKeyName(event);
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;

    onChange({
      key: normalizeKeyName(key),
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      win: event.metaKey,
    });
    setIsCapturing(false);
  }

  return (
    <div className="editor-grid" onKeyDown={handleKeyCapture}>
      <label className="field">
        <span className="field__label">{t("picker.keyLabel")}</span>
        <div className="capture-row">
          <input
            type="text"
            readOnly
            value={draft.key}
            placeholder={isCapturing ? t("picker.keyCapturing") : t("picker.keyEmpty")}
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
      </label>
      <div className="modifier-row">
        {(["ctrl", "shift", "alt", "win"] as const).map((mod) => (
          <label key={mod} className="field field--inline">
            <Toggle
              checked={draft[mod]}
              onChange={(checked) => onChange({ ...draft, [mod]: checked })}
              ariaLabel={mod.charAt(0).toUpperCase() + mod.slice(1)}
            />
            <span className="field__label">{mod.charAt(0).toUpperCase() + mod.slice(1)}</span>
          </label>
        ))}
      </div>
      <p className="panel__muted">
        {t("picker.modifiersHint")}
      </p>
    </div>
  );
}
