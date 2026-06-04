import { useTranslation } from "react-i18next";
import type { PasteMode } from "../../lib/config";

export function TextSnippetEditor({
  draft,
  onChange,
}: {
  draft: { text: string; pasteMode: PasteMode };
  onChange: (draft: { text: string; pasteMode: PasteMode }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid">
      <label className="field">
        <span className="field__label">{t("picker.textLabel")}</span>
        <textarea
          rows={4}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          placeholder={t("picker.textPlaceholder")}
        />
      </label>
    </div>
  );
}
