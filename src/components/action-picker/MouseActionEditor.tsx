import { useTranslation } from "react-i18next";
import type { MouseDraft } from "../../lib/action-picker-helpers";
import { MOUSE_ACTION_OPTIONS } from "../../lib/constants";
import { ModifierRow } from "./shared/ModifierRow";
import { PickerGrid } from "./shared/PickerGrid";

export function MouseActionEditor({
  draft,
  onChange,
  searchQuery = "",
}: {
  draft: MouseDraft;
  onChange: (draft: MouseDraft) => void;
  searchQuery?: string;
}) {
  const { t } = useTranslation();
  const dpiStep = draft.action === "dpiUp" || draft.action === "dpiDown";
  const query = searchQuery.trim().toLowerCase();
  const matches = MOUSE_ACTION_OPTIONS.filter((option) => option.value.toLowerCase().includes(query) || t(option.label).toLowerCase().includes(query));
  const visible = query && matches.length ? matches : MOUSE_ACTION_OPTIONS;
  return (
    <div className="editor-grid">
      <PickerGrid
        options={visible}
        value={draft.action}
        onChange={(action) => onChange(action === "dpiUp" || action === "dpiDown"
          ? { action, ctrl: false, shift: false, alt: false, win: false } : { ...draft, action })}
      />
      {dpiStep ? <p className="field__description">{t("mouse.stageInfo")}</p> : <>
        <ModifierRow value={draft} onChange={(mods) => onChange({ ...draft, ...mods })} />
        <p className="field__description">{t("picker.mouseModifiersHint")}</p>
      </>}
    </div>
  );
}
