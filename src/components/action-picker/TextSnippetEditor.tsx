import { useTranslation } from "react-i18next";
import type { PasteMode, SnippetLibraryItem } from "../../lib/config";
import { LibraryIcon } from "../icons";
import { HelpTip, Notice, Toggle } from "../shared";
import { SnippetLibraryPicker } from "./SnippetLibraryPicker";
import { TokenTextarea } from "./shared/TokenTextarea";

type TextDraft = { text: string; pasteMode: PasteMode; snippetId?: string; enter?: boolean };

export function TextSnippetEditor({
  draft,
  onChange,
  library,
  uses,
  saveToLibrary,
  onToggleSaveToLibrary,
  onPickName,
}: {
  draft: TextDraft;
  onChange: (draft: TextDraft) => void;
  library: SnippetLibraryItem[];
  /** Places using each library text (`snippetPlaceCounts`). */
  uses: ReadonlyMap<string, number>;
  saveToLibrary: boolean;
  onToggleSaveToLibrary: (value: boolean) => void;
  // Selecting a library snippet also fills the action's name field, matching
  // the snippet's name — otherwise the picked text lands but the label stays stale.
  onPickName: (name: string) => void;
}) {
  const { t } = useTranslation();
  // snippetId set => the button is LINKED to a library snippet: the text and
  // the typing mode edited here are the library's, saved for all its uses (as
  // the menu editor does). "Detach" gives the button its own copy instead.
  const linkedSnippet = draft.snippetId ? library.find((s) => s.id === draft.snippetId) : undefined;
  const linked = Boolean(draft.snippetId);
  const keyboardOnly = draft.pasteMode === "keyboardOnly";
  // Mirrors input_synthesis::CLIPBOARD_PASTE_THRESHOLD; never in keyboard-only mode.
  const usesClipboardFastPath = draft.text.length > 100 && !keyboardOnly;

  // A link to a text no longer in the library has nothing to edit: typing detaches.
  function setText(text: string) {
    onChange({ ...draft, text, snippetId: linkedSnippet ? draft.snippetId : undefined });
  }

  function detach() {
    onChange({ ...draft, snippetId: undefined });
    // The copy is the button's own: not a second library entry on Save.
    onToggleSaveToLibrary(false);
  }

  return (
    <div className="editor-grid">
      <SnippetLibraryPicker
        library={library}
        uses={uses}
        linkedId={draft.snippetId}
        onPick={(snippet) => {
          onChange({ ...draft, text: snippet.text, pasteMode: snippet.pasteMode, snippetId: snippet.id });
          onPickName(snippet.name);
        }}
      />

      {linked ? (
        <div className="snippet-linked" role="status">
          <span className="snippet-linked__chip">
            <LibraryIcon />
            {t("snippet.linkedTitle", { name: linkedSnippet?.name ?? draft.snippetId })}
          </span>
          <span className="snippet-linked__meta">
            {linkedSnippet
              ? `${uses.get(linkedSnippet.id) ? t("snippet.usedInPlaces", { count: uses.get(linkedSnippet.id) }) : t("snippet.unusedShort")} · ${t("snippet.linkedEditHint")}`
              : t("snippet.notFound")}
          </span>
          <button type="button" className="action-button action-button--ghost action-button--small snippet-linked__detach"
            onClick={detach} title={t("snippet.detachHint")}>
            {t("snippet.detach")}
          </button>
        </div>
      ) : null}

      <TokenTextarea
        label={t("picker.textLabel")}
        ariaLabel={t("picker.textLabel")}
        value={draft.text}
        onChange={setText}
        placeholder={t("picker.textPlaceholder")}
      />

      {usesClipboardFastPath ? (
        <Notice variant="warning">{t("picker.longTextClipboardWarning")}</Notice>
      ) : null}

      {/* Outer wrappers are <div>s (not <label>) because Toggle renders its own <label>. */}
      <div className="snippet-save-toggle">
        <Toggle
          checked={Boolean(draft.enter)}
          onChange={(on) => onChange({ ...draft, enter: on || undefined })}
          ariaLabel={t("picker.pressEnterAfter")}
        />
        <span>{t("picker.pressEnterAfter")}</span>
        <HelpTip text={t("picker.pressEnterAfterHint")} />
      </div>
      <div className="snippet-save-toggle">
        <Toggle
          checked={keyboardOnly}
          onChange={(on) => onChange({ ...draft, pasteMode: on ? "keyboardOnly" : "sendText" })}
          ariaLabel={t("picker.keyboardOnly")}
        />
        <span>{t("picker.keyboardOnly")}</span>
        <HelpTip text={t(linked ? "picker.keyboardOnlyLibraryHint" : "picker.keyboardOnlyHint")} />
      </div>
      {/* The save-to-library toggle only applies to an inline snippet; a linked
          one is already in the library. */}
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
