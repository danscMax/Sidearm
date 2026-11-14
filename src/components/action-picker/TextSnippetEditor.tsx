import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PasteMode, SnippetLibraryItem } from "../../lib/config";
import { DATE_TOKENS, formatDatePattern, patternOf } from "../../lib/date-pattern";
import { ContextMenu } from "../ContextMenu";
import { HelpTip, Notice, SelectField, Toggle } from "../shared";

type TextDraft = { text: string; pasteMode: PasteMode; snippetId?: string; enter?: boolean };

// The template tokens the backend expands at send time (see
// input_synthesis::expand_snippet_tokens; `{|}` is a short `{cursor}`). Kept in
// sync with that Rust list.
// `{input:name}` is asked for in a small window before the phrase runs (input_prompt.rs).
const TOKEN_RE = /\{(?:date(?::[^{}]+)?|time|clipboard|selection|cursor|\||input:[^{}]+)\}/g;
const INPUT_TOKEN = "{input:…}";
const TOKENS: { token: string; descKey: string }[] = [
  // Opens the list of date and time formats (DATE_TOKENS).
  { token: "{date}", descKey: "picker.tokenDateDesc" },
  { token: "{clipboard}", descKey: "picker.tokenClipboardDesc" },
  { token: "{selection}", descKey: "picker.tokenSelectionDesc" },
  { token: "{cursor}", descKey: "picker.tokenCursorDesc" },
  { token: INPUT_TOKEN, descKey: "picker.tokenInputDesc" },
];

/** Split the text into plain runs and <mark>ed token runs for the highlight
 *  backdrop. A trailing "\n" sentinel keeps the backdrop's last line height in
 *  sync with the textarea under `white-space: pre-wrap`. */
function highlightTokens(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <mark className="token-textarea__mark" key={`${m.index}-${m[0]}`}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  nodes.push(`${text.slice(last)}\n`);
  return nodes;
}

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
  const keyboardOnly = draft.pasteMode === "keyboardOnly";
  // Mirrors input_synthesis::CLIPBOARD_PASTE_THRESHOLD; never in keyboard-only mode.
  const usesClipboardFastPath = draft.text.length > 100 && !keyboardOnly;

  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Caret position to restore after a token is inserted (React re-renders the
  // controlled textarea, so we re-apply the caret in a layout effect).
  const pendingCaret = useRef<number | null>(null);

  function syncScroll() {
    const ta = taRef.current;
    const bd = backdropRef.current;
    if (ta && bd) {
      bd.scrollTop = ta.scrollTop;
      bd.scrollLeft = ta.scrollLeft;
    }
  }

  useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
      syncScroll();
    }
    pendingCaret.current = null;
  });

  // Typing/inserting detaches from a linked library snippet (snippetId cleared).
  function setText(next: string) {
    onChange({ ...draft, text: next, snippetId: undefined });
  }

  // The date chip's list of formats, each shown as today in it.
  const [dateMenuAt, setDateMenuAt] = useState<{ x: number; y: number } | null>(null);
  const months = t("backend.snippet.monthNames").split(",");

  function insertToken(token: string) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.text.length;
    const end = ta?.selectionEnd ?? start;
    pendingCaret.current = start + token.length;
    setText(draft.text.slice(0, start) + token + draft.text.slice(end));
  }

  return (
    <div className="editor-grid">
      {library.length > 0 ? (
        <SelectField<string>
          label={t("snippet.insertFromLibrary")}
          value={draft.snippetId ?? ""}
          onChange={(id) => {
            const snippet = library.find((item) => item.id === id);
            if (snippet) {
              onChange({ ...draft, text: snippet.text, pasteMode: snippet.pasteMode, snippetId: snippet.id });
              onPickName(snippet.name);
            } else {
              // Re-selecting the placeholder unlinks back to an editable inline copy.
              onChange({ ...draft, snippetId: undefined });
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

      <div className="field">
        <span className="field__label">{t("picker.textLabel")}</span>
        <div className="token-textarea">
          <div className="token-textarea__backdrop" ref={backdropRef} aria-hidden="true">
            {highlightTokens(draft.text)}
          </div>
          <textarea
            ref={taRef}
            className="token-textarea__input"
            aria-label={t("picker.textLabel")}
            value={draft.text}
            onChange={(e) => setText(e.target.value)}
            onScroll={syncScroll}
            placeholder={t("picker.textPlaceholder")}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="token-toolbar">
        <span className="token-toolbar__label">
          {t("picker.tokenInsert")}
          <HelpTip text={t("picker.tokenInsertHint")} />
        </span>
        {TOKENS.map(({ token, descKey }) => (
          <button
            key={token}
            type="button"
            className="token-chip"
            onClick={(event) => {
              if (token === "{date}") {
                const box = event.currentTarget.getBoundingClientRect();
                setDateMenuAt({ x: box.left, y: box.bottom + 4 });
              } else insertToken(token === INPUT_TOKEN ? `{input:${t("picker.tokenInputName")}}` : token);
            }}
            title={t(descKey)}
            aria-label={token === "{date}" ? t("picker.tokenDateChip") : t("picker.tokenInsertAria", { token })}
            aria-haspopup={token === "{date}" ? "menu" : undefined}
          >
            {token === "{date}" ? `${t("picker.tokenDateChip")} ▾` : token}
          </button>
        ))}
      </div>
      {dateMenuAt ? (
        <ContextMenu x={dateMenuAt.x} y={dateMenuAt.y} onClose={() => setDateMenuAt(null)}
          items={DATE_TOKENS.map((token) => ({
            label: `${formatDatePattern(patternOf(token), new Date(), months)}   ${token}`,
            onClick: () => { setDateMenuAt(null); insertToken(token); },
          }))} />
      ) : null}

      {usesClipboardFastPath ? (
        <Notice variant="warning">{t("picker.longTextClipboardWarning")}</Notice>
      ) : null}

      {/* The save-to-library toggle only applies to an inline snippet; a linked
          one is already in the library. Outer wrapper is a <div> (not <label>)
          because Toggle renders its own <label>. */}
      <div className="snippet-save-toggle">
        <Toggle
          checked={Boolean(draft.enter)}
          onChange={(on) => onChange({ ...draft, enter: on || undefined })}
          ariaLabel={t("picker.pressEnterAfter")}
        />
        <span>{t("picker.pressEnterAfter")}</span>
        <HelpTip text={t("picker.pressEnterAfterHint")} />
      </div>
      {linked ? null : (
        <div className="snippet-save-toggle">
          <Toggle
            checked={keyboardOnly}
            onChange={(on) => onChange({ ...draft, pasteMode: on ? "keyboardOnly" : "sendText" })}
            ariaLabel={t("picker.keyboardOnly")}
          />
          <span>{t("picker.keyboardOnly")}</span>
          <HelpTip text={t("picker.keyboardOnlyHint")} />
        </div>
      )}
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
