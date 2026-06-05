import { useTranslation } from "react-i18next";
import type { PasteMode, SnippetLibraryItem } from "../../lib/config";

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
        <label className="field">
          <span className="field__label">{t("snippet.insertFromLibrary")}</span>
          <select
            value=""
            onChange={(e) => {
              const snippet = library.find((item) => item.id === e.target.value);
              if (snippet) onChange({ text: snippet.text, pasteMode: snippet.pasteMode });
            }}
          >
            <option value="">{t("snippet.insertPlaceholder")}</option>
            {library.map((snippet) => (
              <option key={snippet.id} value={snippet.id}>
                {snippet.name}
              </option>
            ))}
          </select>
        </label>
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
        <input
          type="checkbox"
          checked={saveToLibrary}
          onChange={(e) => onToggleSaveToLibrary(e.target.checked)}
        />
        <span>{t("snippet.saveToLibrary")}</span>
      </label>
    </div>
  );
}
