import { useTranslation } from "react-i18next";
import type { PasteMode, SnippetLibraryItem } from "../../lib/config";
import { SelectField, Toggle } from "../shared";

type TextDraft = { text: string; pasteMode: PasteMode; snippetId?: string };

export function TextSnippetEditor({
  draft,
  onChange,
  library,
  saveToLibrary,
  onToggleSaveToLibrary,
  onPickName,
}: {
  draft: TextDraft;
  onChange: (draft: TextDraft) => void;
  library: SnippetLibraryItem[];
  saveToLibrary: boolean;
  onToggleSaveToLibrary: (value: boolean) => void;
  // Selecting a library snippet also fills the action's name field, matching
  // the snippet's name — otherwise the picked text lands but the label stays stale.
  onPickName: (name: string) => void;
}) {
  const { t } = useTranslation();
  // snippetId set => the button is LINKED to a library snippet; the textarea
  // previews its text. Typing in the textarea clears snippetId, detaching the
  // button into its own inline copy (link-vs-copy semantics).
  const linked = Boolean(draft.snippetId);
  const linkedSnippet = linked ? library.find((s) => s.id === draft.snippetId) : undefined;

  return (
    <div className="editor-grid">
      {library.length > 0 ? (
        <SelectField<string>
          label={t("snippet.insertFromLibrary")}
          value={draft.snippetId ?? ""}
          onChange={(id) => {
            const snippet = library.find((item) => item.id === id);
            if (snippet) {
              onChange({ text: snippet.text, pasteMode: snippet.pasteMode, snippetId: snippet.id });
              onPickName(snippet.name);
            } else {
              // Re-selecting the placeholder unlinks back to an editable inline copy.
              onChange({ text: draft.text, pasteMode: draft.pasteMode, snippetId: undefined });
            }
          }}
          options={[
            { value: "", label: t("snippet.insertPlaceholder") },
            ...library.map((snippet) => ({ value: snippet.id, label: snippet.name })),
          ]}
        />
      ) : null}

      {linked ? (
        <p className="snippet-linked-hint" role="status">
          {t("snippet.linkedHint", { name: linkedSnippet?.name ?? draft.snippetId })}
        </p>
      ) : null}

      <label className="field">
        <span className="field__label">{t("picker.textLabel")}</span>
        <textarea
          rows={4}
          value={draft.text}
          onChange={(e) =>
            onChange({ text: e.target.value, pasteMode: draft.pasteMode, snippetId: undefined })
          }
          placeholder={t("picker.textPlaceholder")}
        />
      </label>

      {/* The save-to-library toggle only applies to an inline snippet; a linked
          one is already in the library. Outer wrapper is a <div> (not <label>)
          because Toggle renders its own <label>. */}
      {linked ? null : (
        <div className="snippet-save-toggle">
          <Toggle
            checked={saveToLibrary}
            onChange={onToggleSaveToLibrary}
            ariaLabel={t("snippet.saveToLibrary")}
          />
          <span>{t("snippet.saveToLibrary")}</span>
        </div>
      )}
    </div>
  );
}
