import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ShortcutActionPayload } from "../../lib/config";
import { normalizeKeyName, resolveKeyName } from "../../lib/action-picker-helpers";
import { HelpTip } from "../shared";
import { CaptureRow } from "./shared/CaptureRow";
import { ModifierRow } from "./shared/ModifierRow";

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
    // Ignore Sidearm's own injected "menu mask" / hook-probe key (VK 0xE8 = 232).
    // While our window is focused, SendInput delivers it to the WebView as a real
    // keydown (the hook-health probe fires ~every 5s), so without this guard it
    // gets captured as "VK_232" even though the user pressed nothing.
    if (key === "VK_232") return;

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
        <span className="field__label">
          {t("picker.keyLabel")}
          <HelpTip text={t("picker.keyHelp")} />
        </span>
        <CaptureRow
          value={draft.key}
          placeholder={isCapturing ? t("picker.keyCapturing") : t("picker.keyEmpty")}
          capturing={isCapturing}
          onToggle={() => setIsCapturing(!isCapturing)}
          recordLabel={t("picker.recordKey")}
        />
      </label>
      <ModifierRow
        value={draft}
        onChange={(mods) => onChange({ ...draft, ...mods })}
      />
      <p className="field__description">
        {t("picker.modifiersHint")}
      </p>
    </div>
  );
}
