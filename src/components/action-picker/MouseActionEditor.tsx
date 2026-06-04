import { useTranslation } from "react-i18next";
import type { MouseDraft } from "../../lib/action-picker-helpers";
import { MOUSE_ACTION_OPTIONS } from "../../lib/constants";
import { Toggle } from "../shared";

export function MouseActionEditor({
  draft,
  onChange,
}: {
  draft: MouseDraft;
  onChange: (draft: MouseDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid">
      <div className="picker-grid">
        {MOUSE_ACTION_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`picker-grid__btn${draft.action === opt.value ? " picker-grid__btn--active" : ""}`}
            onClick={() => onChange({ ...draft, action: opt.value })}
          >
            {opt.label}
          </button>
        ))}
      </div>
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
        {t("picker.mouseModifiersHint")}
      </p>
    </div>
  );
}
