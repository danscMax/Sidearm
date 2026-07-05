import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./shared";
import { useListKeyboard } from "../hooks/useListKeyboard";
import { filterPaletteResults } from "../lib/command-palette-helpers";
import type { Action, Binding, SnippetLibraryItem } from "../lib/config";

/* ─────────────────────────────────────────────────────────
   Command Palette — commands + cross-profile bindings/snippets
   ───────────────────────────────────────────────────────── */

type Section = "commands" | "bindings" | "snippets" | "recent";

/** A pre-resolved, clickable recent-activity entry (built by App). */
export type RecentPaletteItem = {
  id: string;
  label: string;
  meta: string;
  onSelect: () => void;
};

type Row = {
  section: Section;
  key: string;
  label: string;
  shortcut?: string;
  meta?: string;
  onSelect: () => void;
};

export function CommandPalette({
  onClose,
  onExecute,
  bindings,
  actionsById,
  profileNameById,
  snippets,
  recent,
  onSelectBinding,
  onSelectSnippet,
}: {
  onClose: () => void;
  onExecute: (commandId: string) => void;
  bindings: Binding[];
  actionsById: Map<string, Action>;
  profileNameById: Map<string, string>;
  snippets: SnippetLibraryItem[];
  recent: RecentPaletteItem[];
  onSelectBinding: (binding: Binding) => void;
  onSelectSnippet: (snippet: SnippetLibraryItem) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const paletteCommands = useMemo(
    () => [
      { id: "undo", label: t("command.undo"), shortcut: "Ctrl+Z" },
      { id: "redo", label: t("command.redo"), shortcut: "Ctrl+Y" },
      { id: "reload", label: t("command.reload"), shortcut: "" },
      { id: "new-profile", label: t("command.newProfile"), shortcut: "Ctrl+N" },
      { id: "duplicate-profile", label: t("command.duplicateProfile"), shortcut: "" },
      { id: "add-rule", label: t("command.addRule"), shortcut: "Ctrl+Shift+A" },
      { id: "open-config-folder", label: t("command.openConfigFolder"), shortcut: "" },
      { id: "capture-window", label: t("command.captureWindow"), shortcut: "Ctrl+Shift+C" },
      { id: "tab-profiles", label: t("command.gotoProfiles"), shortcut: "1" },
      { id: "tab-debug", label: t("command.gotoDebug"), shortcut: "2" },
      { id: "tab-settings", label: t("command.gotoSettings"), shortcut: "3" },
      { id: "layer-standard", label: t("command.layerStandard"), shortcut: "" },
      { id: "layer-hypershift", label: t("command.layerHypershift"), shortcut: "" },
      { id: "shortcuts", label: t("command.shortcuts"), shortcut: "?" },
      { id: "toggle-runtime", label: t("command.toggleRuntime"), shortcut: "" },
      { id: "open-snippet-library", label: t("command.snippetLibrary"), shortcut: "" },
      { id: "open-presets", label: t("command.presets"), shortcut: "" },
      { id: "export-profile", label: t("command.exportProfile"), shortcut: "" },
    ],
    [t],
  );

  const layerLabel = useCallback(
    (layer: Binding["layer"]) =>
      layer === "hypershift" ? t("layer.hypershift") : t("layer.standard"),
    [t],
  );

  // Build the flat list of selectable rows (display order). Section headers are
  // injected at render time when the section changes; only rows are selectable.
  const rows: Row[] = useMemo(() => {
    const results = filterPaletteResults(query, {
      commands: paletteCommands,
      bindings,
      actionsById,
      snippets,
    });
    const out: Row[] = results.commands.map((cmd) => ({
      section: "commands" as const,
      key: cmd.id,
      label: cmd.label,
      shortcut: cmd.shortcut,
      onSelect: () => onExecute(cmd.id),
    }));

    if (query.trim()) {
      for (const b of results.bindings) {
        out.push({
          section: "bindings",
          key: b.id,
          label: b.label || actionsById.get(b.actionId)?.displayName || b.controlId,
          meta: `${profileNameById.get(b.profileId) ?? b.profileId} · ${layerLabel(b.layer)}`,
          onSelect: () => onSelectBinding(b),
        });
      }
      for (const s of results.snippets) {
        out.push({
          section: "snippets",
          key: s.id,
          label: s.name,
          meta: s.text.slice(0, 48).replace(/\s+/g, " "),
          onSelect: () => onSelectSnippet(s),
        });
      }
    } else {
      for (const r of recent) {
        out.push({ section: "recent", key: r.id, label: r.label, meta: r.meta, onSelect: r.onSelect });
      }
    }
    return out;
  }, [
    query,
    paletteCommands,
    bindings,
    actionsById,
    snippets,
    onExecute,
    profileNameById,
    layerLabel,
    onSelectBinding,
    onSelectSnippet,
    recent,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Escape is handled by ModalShell's useModalDismiss; this covers list nav.
  const handleKeyDown = useListKeyboard({
    itemCount: rows.length,
    activeIndex,
    setActiveIndex,
    onSelect: (i) => {
      rows[i]?.onSelect();
    },
  });

  const sectionLabel = (section: Section) =>
    t(
      section === "commands"
        ? "command.sectionCommands"
        : section === "bindings"
          ? "command.sectionBindings"
          : section === "snippets"
            ? "command.sectionSnippets"
            : "command.sectionRecent",
    );

  let prevSection: Section | null = null;
  const listboxId = "command-palette-listbox";
  const activeOptionId = rows[activeIndex]
    ? `command-palette-option-${activeIndex}`
    : undefined;

  return (
    <ModalShell
      onClose={onClose}
      className="command-palette"
      ariaLabel={t("command.placeholder")}
      onKeyDown={handleKeyDown}
    >
      <input
        className="command-palette__input"
        type="text"
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("command.placeholder")}
        autoFocus
      />
      {rows.length > 0 ? (
        <ul id={listboxId} className="command-palette__list" role="listbox">
          {rows.map((row, index) => {
            const header =
              row.section !== prevSection ? (
                <li className="command-palette__section" role="presentation">
                  {sectionLabel(row.section)}
                </li>
              ) : null;
            prevSection = row.section;
            return (
              <Fragment key={`${row.section}:${row.key}`}>
                {header}
                <li
                  id={`command-palette-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`command-palette__item${index === activeIndex ? " command-palette__item--active" : ""}`}
                  onClick={() => row.onSelect()}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="command-palette__item-label">{row.label}</span>
                  {row.meta ? <span className="command-palette__item-meta">{row.meta}</span> : null}
                  {row.shortcut ? <span className="command-palette__shortcut">{row.shortcut}</span> : null}
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : (
        <div className="command-palette__empty">{t("command.empty")}</div>
      )}
    </ModalShell>
  );
}
