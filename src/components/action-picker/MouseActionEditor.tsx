import { useTranslation } from "react-i18next";
import type { MouseDraft } from "../../lib/action-picker-helpers";
import { MOUSE_ACTION_OPTIONS } from "../../lib/constants";
import { ModifierRow } from "./shared/ModifierRow";
import { PickerGrid } from "./shared/PickerGrid";

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
      <PickerGrid
        options={MOUSE_ACTION_OPTIONS}
        value={draft.action}
        onChange={(action) => onChange({ ...draft, action })}
      />
      <ModifierRow value={draft} onChange={(mods) => onChange({ ...draft, ...mods })} />
      <p className="field__description">
        {t("picker.mouseModifiersHint")}
      </p>
    </div>
  );
}
