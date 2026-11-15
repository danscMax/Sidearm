import { useTranslation } from "react-i18next";
import { OFFLINE_MOUSE_ACTION_OPTIONS, type MouseDraft } from "../../lib/action-picker-helpers";
import { MOUSE_ACTION_OPTIONS } from "../../lib/constants";
import { ModifierRow } from "./shared/ModifierRow";
import { PickerGrid } from "./shared/PickerGrid";

export function MouseActionEditor({
  draft,
  onChange,
  searchQuery = "",
  offline = false,
}: {
  draft: MouseDraft;
  onChange: (draft: MouseDraft) => void;
  searchQuery?: string;
  offline?: boolean;
}) {
  const { t } = useTranslation();
  const dpiStep = draft.action === "dpiUp" || draft.action === "dpiDown";
  const query = searchQuery.trim().toLowerCase();
  const options = offline ? OFFLINE_MOUSE_ACTION_OPTIONS : MOUSE_ACTION_OPTIONS;
  const matches = options.filter((option) => option.value.toLowerCase().includes(query) || t(option.label).toLowerCase().includes(query));
  const visible = query && matches.length ? matches : options;
  return (
    <div className="editor-grid">
      <PickerGrid
        options={visible}
        value={draft.action}
        onChange={(action) => onChange(action === "dpiUp" || action === "dpiDown"
          ? { action, ctrl: false, shift: false, alt: false, win: false } : { ...draft, action })}
      />
      {offline ? null : dpiStep ? <p className="panel__muted help-sm">{t("mouse.stageInfo")}</p> : <>
        <ModifierRow value={draft} onChange={(mods) => onChange({ ...draft, ...mods })} />
        <p className="panel__muted help-sm">{t("picker.mouseModifiersHint")}</p>
      </>}
    </div>
  );
}
