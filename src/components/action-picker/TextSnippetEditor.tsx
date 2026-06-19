import { useTranslation } from "react-i18next";
import type { PasteMode, SnippetLibraryItem } from "../../lib/config";
import { SelectField, Toggle } from "../shared";

export function TextSnippetEditor({
  draft,
  onChange,
  library,
  saveToLibrary,
  onToggleSaveToLibrary,
}: {
  draft: { text: string; pasteMode: PasteMode };
  onChange: (draft: { text: string; pasteMode: PasteMode }) => void;
  library: SnippetLibraryItem[];
  saveToLibrary: boolean;
  onToggleSaveToLibrary: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid">
      {library.length > 0 ? (
        <SelectField<string>
          label={t("snippet.insertFromLibrary")}
          value=""
          onChange={(id) => {
            const snippet = library.find((item) => item.id === id);
            if (snippet) onChange({ text: snippet.text, pasteMode: snippet.pasteMode });
          }}
          options={[
            { value: "", label: t("snippet.insertPlaceholder") },
            ...library.map((snippet) => ({ value: snippet.id, label: snippet.name })),
          ]}
        />
      ) : null}
      <label className="field">
        <span className="field__label">{t("picker.textLabel")}</span>
        <textarea
          rows={4}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          placeholder={t("picker.textPlaceholder")}
        />
      </label>
      <label className="snippet-save-toggle">
        <Toggle
          checked={saveToLibrary}
          onChange={onToggleSaveToLibrary}
          ariaLabel={t("snippet.saveToLibrary")}
        />
        <span>{t("snippet.saveToLibrary")}</span>
      </label>
    </div>
  );
}
