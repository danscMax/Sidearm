import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../../hooks/useDismissable";
import { useListKeyboard } from "../../hooks/useListKeyboard";
import type { SnippetLibraryItem } from "../../lib/config";
import { searchSnippets } from "../../lib/snippet-search";
import { ChevronIcon, LibraryIcon } from "../icons";

/** The first line with text in it, for a row's preview. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

/** "Insert from library": a button opening a searchable list of the library's
 *  texts — name, first line, tags, typing mode and how many places use each —
 *  driven by ↑ ↓ Enter Esc from its search box. */
export function SnippetLibraryPicker({
  library,
  uses,
  linkedId,
  onPick,
}: {
  library: readonly SnippetLibraryItem[];
  /** Places using each text (`snippetPlaceCounts`). */
  uses: ReadonlyMap<string, number>;
  /** The text this action is linked to, marked in the list. */
  linkedId?: string;
  onPick: (snippet: SnippetLibraryItem) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = searchSnippets(library, query);

  function close() {
    setOpen(false);
    setQuery("");
  }
  useDismissable(rootRef, close, open);

  function toggle() {
    if (open) return close();
    // Open on the linked text, if any.
    setActive(Math.max(0, searchSnippets(library, "").findIndex((snippet) => snippet.id === linkedId)));
    setOpen(true);
  }

  function pick(index: number) {
    const snippet = results[index];
    if (!snippet) return;
    onPick(snippet);
    close();
  }
  const onKeyDown = useListKeyboard({ itemCount: results.length, activeIndex: active, setActiveIndex: setActive, onSelect: pick });

  useLayoutEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);
  // Closed by Esc or a pick, the search box is gone: focus goes back to the button.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      if (document.activeElement === document.body || !document.activeElement) triggerRef.current?.focus();
    }
  }, [open]);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <div className="lib-picker" ref={rootRef}>
      <button ref={triggerRef} type="button" className="lib-picker__trigger" aria-haspopup="listbox" aria-expanded={open}
        onClick={toggle}>
        <LibraryIcon />
        <span>{t(linkedId ? "snippet.pickOther" : "snippet.insertFromLibrary")}</span>
        <span className="lib-picker__count">{library.length}</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="lib-picker__pop">
          {library.length > 0 ? (
            <input
              ref={searchRef}
              className="input lib-picker__search"
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results[active] ? optionId(active) : undefined}
              aria-label={t("snippet.pickerSearch")}
              placeholder={t("snippet.pickerSearch")}
              value={query}
              autoComplete="off"
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
            />
          ) : null}
          {library.length === 0 ? (
            <p className="lib-picker__empty">{t("snippet.pickerEmpty")}</p>
          ) : results.length === 0 ? (
            <p className="lib-picker__empty">{t("snippet.pickerNoResults", { query: query.trim() })}</p>
          ) : (
            <ul className="lib-picker__list" id={listId} role="listbox" ref={listRef} aria-label={t("snippet.insertFromLibrary")}>
              {results.map((snippet, index) => {
                const count = uses.get(snippet.id) ?? 0;
                const line = firstLine(snippet.text);
                const linked = snippet.id === linkedId;
                return (
                  <li
                    key={snippet.id}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    className={`lib-picker__row${index === active ? " lib-picker__row--active" : ""}${linked ? " lib-picker__row--linked" : ""}`}
                    title={snippet.text.slice(0, 400)}
                    onMouseEnter={() => setActive(index)}
                    // Keep the focus in the search box.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(index)}
                  >
                    <span className="lib-picker__name">{snippet.name}</span>
                    <span className="lib-picker__uses">
                      {linked ? t("snippet.pickerLinked") : count > 0 ? t("snippet.placesShort", { count }) : t("snippet.unusedShort")}
                    </span>
                    <span className="lib-picker__line">{line || t("snippetLibrary.emptyPreview")}</span>
                    {snippet.tags.length > 0 || snippet.pasteMode === "keyboardOnly" ? (
                      <span className="lib-picker__badges">
                        {snippet.pasteMode === "keyboardOnly" ? (
                          <span className="lib-picker__badge lib-picker__badge--mode">{t("snippet.badgeTyped")}</span>
                        ) : null}
                        {snippet.tags.slice(0, 3).map((tag) => <span key={tag} className="lib-picker__badge">{tag}</span>)}
                        {snippet.tags.length > 3 ? <span className="lib-picker__badge">+{snippet.tags.length - 3}</span> : null}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {results.length > 0 ? <p className="lib-picker__keys">{t("snippet.pickerKeys")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
