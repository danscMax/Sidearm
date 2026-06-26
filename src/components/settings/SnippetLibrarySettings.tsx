import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, PasteMode, SnippetLibraryItem } from "../../lib/config";
import type { ConfirmModalRequest } from "../ConfirmModal";
import {
  upsertSnippetLibraryItem,
  removeSnippetLibraryItem,
  snippetReferenceCount,
  makeSnippetId,
  nextUniqueId,
} from "../../lib/config-editing";
import { SelectField } from "../shared";
import { TrashIcon } from "../icons";

export interface SnippetLibrarySettingsProps {
  activeConfig: AppConfig;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
}

/** Snippets tab: full CRUD over the reusable snippet library —
 *  add / rename / edit text + paste mode / delete. Selected snippet edits
 *  on top, the whole library lists below (mirrors the Profiles tab). */
export function SnippetLibrarySettings({
  activeConfig,
  updateDraft,
  setConfirmModal,
}: SnippetLibrarySettingsProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const library = activeConfig.snippetLibrary;
  const selected = library.find((s) => s.id === selectedId) ?? null;

  const pasteOptions: ReadonlyArray<{ value: PasteMode; label: string }> = [
    { value: "clipboardPaste", label: t("paste.clipboard") },
    { value: "sendText", label: t("paste.direct") },
  ];

  function patch(id: string, fields: Partial<SnippetLibraryItem>) {
    updateDraft((c) => {
      const current = c.snippetLibrary.find((s) => s.id === id);
      if (!current) return c;
      return upsertSnippetLibraryItem(c, { ...current, ...fields });
    });
  }

  function handleAdd() {
    const name = t("snippetLibrary.newSnippetName");
    const id = nextUniqueId(
      activeConfig.snippetLibrary.map((s) => s.id),
      makeSnippetId(name),
    );
    updateDraft((c) =>
      upsertSnippetLibraryItem(c, { id, name, text: "", pasteMode: "clipboardPaste", tags: [] }),
    );
    setSelectedId(id);
  }

  function handleDelete(snippet: SnippetLibraryItem) {
    const refs = snippetReferenceCount(activeConfig, snippet.id);
    setConfirmModal({
      title: t("snippetLibrary.deleteConfirmTitle"),
      message:
        refs > 0
          ? t("snippetLibrary.deleteConfirmReferenced", { name: snippet.name, count: refs })
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
    <>
      {selected ? (
        <section className="settings-section">
          <div className="settings-editor">
            <div className="settings-editor__title">{selected.name}</div>

            <label className="field">
              <span className="field__label">{t("snippet.name")}</span>
              <input
                type="text"
                value={selected.name}
                onChange={(e) => patch(selected.id, { name: e.target.value })}
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
                onChange={(e) => patch(selected.id, { text: e.target.value })}
                placeholder={t("picker.textPlaceholder")}
              />
            </label>

            <SelectField<PasteMode>
              label={t("snippetLibrary.pasteModeLabel")}
              value={selected.pasteMode}
              options={pasteOptions}
              onChange={(mode) => patch(selected.id, { pasteMode: mode })}
            />

            <div className="settings-actions">
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
        </section>
      ) : null}

      <section className="settings-section">
        <div className="settings-section__header">
          <span className="settings-section__title">{t("snippet.eyebrow")}</span>
          <span className="settings-section__count">{library.length}</span>
        </div>

        {library.length === 0 ? (
          <p className="panel__muted">{t("snippetLibrary.emptyList")}</p>
        ) : (
          <div className="settings-profile-list">
            {library.map((snippet) => {
              const refs = snippetReferenceCount(activeConfig, snippet.id);
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
                      {t("snippet.usageCount", { count: refs })}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="settings-actions mt-12">
          <button type="button" className="action-button" onClick={handleAdd}>
            {t("snippetLibrary.addButton")}
          </button>
        </div>
      </section>
    </>
  );
}
