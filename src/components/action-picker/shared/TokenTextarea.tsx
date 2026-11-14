import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DATE_TOKENS, formatDatePattern, patternOf } from "../../../lib/date-pattern";
import { previewSnippet, replaceToken, scanSnippet, snippetWarnings, type SnippetWarning } from "../../../lib/snippet-tokens";
import { ContextMenu } from "../../ContextMenu";
import { HelpTip } from "../../shared";

// `{input:name}` is asked for in a small window before the phrase runs (input_prompt.rs).
const INPUT_TOKEN = "{input:…}";
const TOKENS: { token: string; descKey: string }[] = [
  // Opens the list of date and time formats (DATE_TOKENS).
  { token: "{date}", descKey: "picker.tokenDateDesc" },
  { token: "{clipboard}", descKey: "picker.tokenClipboardDesc" },
  { token: "{selection}", descKey: "picker.tokenSelectionDesc" },
  { token: "{cursor}", descKey: "picker.tokenCursorDesc" },
  { token: INPUT_TOKEN, descKey: "picker.tokenInputDesc" },
];

/** The text split into plain runs and <mark>ed token runs for the highlight
 *  backdrop, read as the backend reads it (`{{date}}` is no token); a mistake
 *  is marked as a warning. A trailing "\n" sentinel keeps the backdrop's last
 *  line height in sync with the textarea under `white-space: pre-wrap`. */
function highlightTokens(text: string, warned: ReadonlySet<string>): ReactNode[] {
  const nodes: ReactNode[] = [];
  scanSnippet(text).forEach((part, index) => {
    const warn = warned.has(part.raw);
    if (part.kind === "text" || (part.kind === "unknown" && !warn)) nodes.push(part.raw);
    else nodes.push(<mark className={`token-textarea__mark${warn ? " token-textarea__mark--warn" : ""}`} key={index}>{part.raw}</mark>);
  });
  nodes.push("\n");
  return nodes;
}

/** A phrase's text box: tokens highlighted, a row of chips inserting them at
 *  the caret (the date chip opens the formats), a one-line preview of what it
 *  types and the likely mistakes with their fix. Shared by the Text editor and
 *  the menu editor's phrase. */
export function TokenTextarea({
  value,
  onChange,
  ariaLabel,
  label,
  placeholder,
  disabled,
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  ariaLabel: string;
  /** A visible caption above the box. */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Caret position to restore after a token is inserted (React re-renders the
  // controlled textarea, so we re-apply the caret in a layout effect).
  const pendingCaret = useRef<number | null>(null);
  // The date chip's list of formats, each shown as today in it.
  const [dateMenuAt, setDateMenuAt] = useState<{ x: number; y: number } | null>(null);
  const months = t("backend.snippet.monthNames").split(",");
  const warnings = snippetWarnings(value);
  const warned = new Set(warnings.map((warning) => warning.raw));
  const preview = /[{}]/.test(value) ? previewSnippet(value, new Date(), months) : null;

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

  function insertToken(token: string) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? start;
    pendingCaret.current = start + token.length;
    onChange(value.slice(0, start) + token + value.slice(end));
  }

  function warningText(warning: SnippetWarning): string {
    if (warning.kind === "datePattern") return t("picker.tokenDateLetters", { token: warning.raw });
    return t(warning.fix ? "picker.tokenUnknownLike" : "picker.tokenUnknown", { token: warning.raw, fix: warning.fix });
  }

  return (
    <div className={`token-editor${className ? ` ${className}` : ""}`}>
      {label ? <span className="field__label">{label}</span> : null}
      <div className="token-textarea">
        <div className="token-textarea__backdrop" ref={backdropRef} aria-hidden="true">
          {highlightTokens(value, warned)}
        </div>
        <textarea
          ref={taRef}
          className="token-textarea__input"
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          placeholder={placeholder}
          spellCheck={false}
        />
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
            disabled={disabled}
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
      {preview ? (
        <p className="token-preview" title={t("picker.previewHint")}>
          <span className="token-preview__label">{t("picker.tokenPreviewLabel")}</span>
          <span className="token-preview__text">
            {preview.map((part, index) => ("text" in part
              ? <span key={index}>{part.text}</span>
              : <span key={index} className="token-preview__slot">
                  {part.input ? part.placeholder : t(`picker.previewSlot.${part.placeholder}`)}
                </span>))}
          </span>
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="token-warnings" aria-label={t("picker.tokenWarnings")}>
          {warnings.map((warning) => (
            <li key={warning.raw} className="token-warning">
              <span className="token-warning__text">{warningText(warning)}</span>
              {warning.fix ? (
                <button type="button" className="token-warning__fix" disabled={disabled}
                  onClick={() => onChange(replaceToken(value, warning.raw, warning.fix!))}>
                  {t("picker.tokenFix", { fix: warning.fix })}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {dateMenuAt ? (
        <ContextMenu x={dateMenuAt.x} y={dateMenuAt.y} onClose={() => setDateMenuAt(null)}
          items={DATE_TOKENS.map((token) => ({
            label: `${formatDatePattern(patternOf(token), new Date(), months)}   ${token}`,
            onClick: () => { setDateMenuAt(null); insertToken(token); },
          }))} />
      ) : null}
    </div>
  );
}
