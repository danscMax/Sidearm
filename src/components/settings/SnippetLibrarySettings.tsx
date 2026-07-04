import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, SnippetLibraryItem } from "../../lib/config";
import type { ConfirmModalRequest } from "../ConfirmModal";
import {
  upsertSnippetLibraryItem,
  removeSnippetLibraryItem,
  snippetReferencingActions,
  mergeSnippetLibrary,
  dedupeSnippetLibrary,
  makeSnippetId,
  nextUniqueId,
} from "../../lib/config-editing";
import {
  exportSnippetLibraryToFile,
  importSnippetLibraryFromFile,
} from "../../lib/snippet-transfer";
import { normalizeCommandError } from "../../lib/backend";
import { ChipEditor } from "../ChipEditor";
import { CopyIcon, ExportIcon, ImportIcon, TrashIcon } from "../icons";

export interface SnippetLibrarySettingsProps {
  activeConfig: AppConfig;
  updateDraft: (
    updater: (config: AppConfig) => AppConfig,
    options?: { immediate?: boolean; coalesceKey?: string },
  ) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
  selectedSnippetId?: string;
}

/** Snippets tab: full CRUD over the reusable snippet library — add / rename /
 *  edit text + tags + notes / duplicate / delete (delete re-inlines linked
 *  buttons). Selected snippet edits on top, the library lists below. */
export function SnippetLibrarySettings({
  activeConfig,
  updateDraft,
  setConfirmModal,
  showToast,
  selectedSnippetId,
}: SnippetLibrarySettingsProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const library = activeConfig.snippetLibrary;
  const selected = library.find((s) => s.id === selectedId) ?? null;
  const snippetRefCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const action of activeConfig.actions) {
      if (action.type === "textSnippet" && action.payload.source === "libraryRef") {
        counts.set(action.payload.snippetId, (counts.get(action.payload.snippetId) ?? 0) + 1);
      }
    }
    return counts;
  }, [activeConfig.actions]);

  // Alphabetical, then filtered by name/text — a flat insertion-order list
  // doesn't scale to the dozens of snippets this tab is built for.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...library]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.text.toLowerCase().includes(q) ||
          s.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          (s.notes ?? "").toLowerCase().includes(q),
      );
  }, [library, query]);

  // Focus the editor's name field when a snippet is selected — but with
  // preventScroll so the master-detail list never jumps (the editor is its own
  // sticky pane; scrolling it into view would yank the page on every click).
  useEffect(() => {
    if (selectedId) nameInputRef.current?.focus({ preventScroll: true });
  }, [selectedId]);

  useEffect(() => {
    if (selectedSnippetId && library.some((snippet) => snippet.id === selectedSnippetId)) {
      setSelectedId(selectedSnippetId);
    }
  }, [library, selectedSnippetId]);

  function handleDedupe() {
    let removed = 0;
    updateDraft((c) => {
      const result = dedupeSnippetLibrary(c);
      removed = result.removed;
      return result.config;
    });
    showToast(
      removed > 0
        ? t("snippetLibrary.dedupeDone", { count: removed })
        : t("snippetLibrary.dedupeNone"),
      removed > 0 ? "success" : "info",
    );
  }

  function patch(id: string, fields: Partial<SnippetLibraryItem>, coalesceKey?: string) {
    updateDraft(
      (c) => {
        const current = c.snippetLibrary.find((s) => s.id === id);
        if (!current) return c;
        return upsertSnippetLibraryItem(c, { ...current, ...fields });
      },
      coalesceKey ? { coalesceKey } : undefined,
    );
  }

  function handleAdd() {
    const name = t("snippetLibrary.newSnippetName");
    const id = nextUniqueId(library.map((s) => s.id), makeSnippetId(name));
    // Seed non-empty text: the backend rejects empty-text snippets, which would
    // fail the debounced whole-config save and roll back unsaved edits.
    updateDraft((c) =>
      upsertSnippetLibraryItem(c, {
        id,
        name,
        text: t("snippetLibrary.newSnippetText"),
        pasteMode: "sendText",
        tags: [],
      }),
    );
    setSelectedId(id);
  }

  function handleDuplicate(snippet: SnippetLibraryItem) {
    const name = t("snippetLibrary.copyName", { name: snippet.name });
    const id = nextUniqueId(library.map((s) => s.id), makeSnippetId(name));
    updateDraft((c) =>
      upsertSnippetLibraryItem(c, {
        ...snippet,
        id,
        name,
        tags: [...snippet.tags],
      }),
    );
    setSelectedId(id);
  }

  async function handleExport() {
    try {
      await exportSnippetLibraryToFile(
        activeConfig,
        t("snippetLibrary.exportDialogTitle"),
        t("snippetLibrary.exportFileName"),
      );
    } catch (unknownError) {
      showToast(normalizeCommandError(unknownError).message, "warning");
    }
  }

  async function handleImport() {
    try {
      const result = await importSnippetLibraryFromFile(t("snippetLibrary.importDialogTitle"));
      if (result.status === "cancelled") return;
      if (result.status === "invalid") {
        showToast(t("snippetLibrary.importInvalid"), "warning");
        return;
      }
      const before = activeConfig.snippetLibrary.length;
      let after = before;
      updateDraft((c) => {
        const merged = mergeSnippetLibrary(c, result.snippets);
        after = merged.snippetLibrary.length;
        return merged;
      });
      showToast(t("snippetLibrary.importDone", { count: after - before }), "success");
    } catch (unknownError) {
      showToast(normalizeCommandError(unknownError).message, "warning");
    }
  }

  function handleDelete(snippet: SnippetLibraryItem) {
    const refs = snippetReferencingActions(activeConfig, snippet.id);
    const visibleRefNames = refs.slice(0, 5).map((a) => a.displayName).join(", ");
    const refsSummary =
      refs.length > 5
        ? t("snippetLibrary.referencesSummary", {
            actions: visibleRefNames,
            count: refs.length - 5,
          })
        : visibleRefNames;
    setConfirmModal({
      title: t("snippetLibrary.deleteConfirmTitle"),
      message:
        refs.length > 0
          ? t("snippetLibrary.deleteConfirmReferenced", {
              name: snippet.name,
              count: refs.length,
              actions: refsSummary,
            })
          : t("snippetLibrary.deleteConfirmMessage", { name: snippet.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: () => {
        updateDraft((c) => removeSnippetLibraryItem(c, snippet.id));
        if (selectedId === snippet.id) setSelectedId(null);
        setConfirmModal(null);
      },
    });
  }

  return (
    <div className="snippet-library">
      {/* LEFT: roster (own scroll) + actions. Selecting a row only changes the
          right pane, so the list never jumps. */}
      <div className="snippet-library__list-pane">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("snippet.eyebrow")}</span>
          <span className="settings-section__count">{library.length}</span>
        </div>

        {library.length === 0 ? (
          <p className="panel__muted">{t("snippetLibrary.emptyList")}</p>
        ) : (
          <>
            {library.length > 1 ? (
              <input
                className="action-picker__search"
                type="search"
                placeholder={t("snippetLibrary.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
            ) : null}
            <div className="settings-profile-list snippet-library__list">
              {visible.map((snippet) => {
                const refs = snippetRefCounts.get(snippet.id) ?? 0;
                const preview = snippet.text.replace(/\s+/g, " ").trim().slice(0, 48);
                return (
                  <div
                    key={snippet.id}
                    className={`settings-profile-card${snippet.id === selectedId ? " settings-profile-card--active" : ""}`}
                  >
                    <button
                      type="button"
                      className="settings-profile-card__info"
                      aria-pressed={snippet.id === selectedId}
                      onClick={() => setSelectedId(snippet.id)}
                    >
                      <span className="settings-profile-card__name">{snippet.name}</span>
                      <span className="settings-profile-card__meta">
                        {preview || t("snippetLibrary.emptyPreview")}
                      </span>
                      <span className="settings-profile-card__meta">
                        {t("snippet.usageCount", { count: refs })}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="settings-actions mt-12">
          <button type="button" className="action-button action-button--accent" onClick={handleAdd}>
            {t("snippetLibrary.addButton")}
          </button>
          {library.length > 1 ? (
            <button
              type="button"
              className="action-button action-button--secondary"
              onClick={handleDedupe}
            >
              {t("snippetLibrary.dedupeButton")}
            </button>
          ) : null}
          {library.length > 0 ? (
            <button
              type="button"
              className="action-button action-button--secondary"
              onClick={() => { void handleExport(); }}
            >
              <ExportIcon />
              {t("common.export")}
            </button>
          ) : null}
          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => { void handleImport(); }}
          >
            <ImportIcon />
            {t("snippetLibrary.importButton")}
          </button>
        </div>
      </div>

      {/* RIGHT: sticky editor for the selected snippet (or an empty hint). */}
      <div className="snippet-library__editor-pane">
        {selected ? (
          <div className="settings-editor">
            <div className="settings-editor__title">{selected.name}</div>

            <label className="field">
              <span className="field__label">{t("snippet.name")}</span>
              <input
                ref={nameInputRef}
                type="text"
                value={selected.name}
                onChange={(e) => patch(selected.id, { name: e.target.value }, `snippet-name:${selected.id}`)}
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    patch(selected.id, { name: t("snippetLibrary.newSnippetName") });
                  }
                }}
              />
            </label>

            <label className="field">
              <span className="field__label">{t("snippet.text")}</span>
              <textarea
                rows={4}
                value={selected.text}
                onChange={(e) => patch(selected.id, { text: e.target.value }, `snippet-text:${selected.id}`)}
                placeholder={t("picker.textPlaceholder")}
              />
            </label>

            <div className="field">
              <span className="field__label">{t("snippet.tags")}</span>
              <ChipEditor
                values={selected.tags}
                onChange={(tags) => patch(selected.id, { tags })}
                ariaLabel={t("snippet.tags")}
                placeholder={t("snippet.tagsPlaceholder")}
              />
            </div>

            <label className="field">
              <span className="field__label">{t("snippet.notes")}</span>
              <textarea
                rows={2}
                value={selected.notes ?? ""}
                onChange={(e) => patch(selected.id, { notes: e.target.value || undefined }, `snippet-notes:${selected.id}`)}
                placeholder={t("snippet.notesPlaceholder")}
              />
            </label>

            <div className="settings-actions">
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                onClick={() => handleDuplicate(selected)}
              >
                <CopyIcon />
                {t("inspector.copyLabel")}
              </button>
              <button
                type="button"
                className="action-button action-button--small action-button--danger"
                onClick={() => handleDelete(selected)}
              >
                <TrashIcon />
                {t("common.delete")}
              </button>
            </div>
          </div>
        ) : (
          <p className="panel__muted snippet-library__empty-hint">
            {t("snippetLibrary.selectHint")}
          </p>
        )}
      </div>
    </div>
  );
}
