import type {
  Action,
  AppConfig,
  SnippetLibraryItem,
} from "../lib/config";
import { upsertSnippetLibraryItem } from "../lib/config-editing";
import { parseCommaSeparatedUniqueValues } from "../lib/helpers";

export interface SnippetLibraryEditorProps {
  activeConfig: AppConfig;
  selectedAction: Action | null;
  snippetById: Map<string, SnippetLibraryItem>;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
}

export function SnippetLibraryEditor({
  activeConfig,
  selectedAction,
  snippetById,
  updateDraft,
}: SnippetLibraryEditorProps) {
  // --- Derived values ---
  const selectedSnippet =
    selectedAction &&
    selectedAction.type === "textSnippet" &&
    "source" in selectedAction.payload &&
    selectedAction.payload.source === "libraryRef"
      ? snippetById.get(selectedAction.payload.snippetId) ?? null
      : null;

  const selectedSnippetUsageCount =
    selectedSnippet
      ? activeConfig.actions.filter(
          (action) =>
            action.type === "textSnippet" &&
            "source" in action.payload &&
            action.payload.source === "libraryRef" &&
            action.payload.snippetId === selectedSnippet.id,
        ).length
      : 0;

  function updateSelectedSnippetDraft(
    updateSnippet: (snippet: SnippetLibraryItem) => SnippetLibraryItem,
  ) {
    if (!selectedSnippet) {
      return;
    }

    const snippetId = selectedSnippet.id;
    updateDraft((config) => {
      const freshSnippet = config.snippetLibrary.find((s) => s.id === snippetId);
      if (!freshSnippet) return config;
      return upsertSnippetLibraryItem(config, updateSnippet(freshSnippet));
    });
  }

  return (
    <section className="panel">
      <p className="panel__eyebrow">Библиотека фрагментов</p>
      {selectedAction &&
      selectedAction.type === "textSnippet" &&
      "source" in selectedAction.payload ? (
        selectedAction.payload.source === "libraryRef" ? (
          selectedSnippet ? (
            <div className="editor-grid">
              <div className="field">
                <span className="field__label">ID фрагмента</span>
                <code className="field__static">{selectedSnippet.id}</code>
              </div>

              <label className="field">
                <span className="field__label">Название фрагмента</span>
                <input
                  type="text"
                  value={selectedSnippet.name}
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      name: event.target.value,
                    }));
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Текст фрагмента</span>
                <textarea
                  rows={6}
                  value={selectedSnippet.text}
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      text: event.target.value,
                    }));
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Способ вставки</span>
                <select
                  value={selectedSnippet.pasteMode}
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      pasteMode: event.target.value as
                        | "clipboardPaste"
                        | "sendText",
                    }));
                  }}
                >
                  <option value="clipboardPaste">Через буфер обмена</option>
                  <option value="sendText">Прямой ввод текста</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">Теги</span>
                <input
                  type="text"
                  value={selectedSnippet.tags.join(", ")}
                  placeholder="тег1, тег2, тег3"
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      tags: parseCommaSeparatedUniqueValues(event.target.value),
                    }));
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Заметки</span>
                <textarea
                  rows={3}
                  value={selectedSnippet.notes ?? ""}
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      notes: event.target.value || undefined,
                    }));
                  }}
                />
              </label>

              <p className="panel__muted">
                Этот фрагмент используют действий: {selectedSnippetUsageCount}.
              </p>
            </div>
          ) : (
            <div className="notice notice--error">
              <strong>Запись библиотеки не найдена</strong>
              <p>
                Выбранное действие ссылается на фрагмент, которого нет
                в <code>snippetLibrary</code>.
              </p>
            </div>
          )
        ) : (
          <p className="panel__muted">
            Сейчас текст хранится прямо внутри действия.
          </p>
        )
      ) : (
        <p className="panel__muted">
          Выберите действие типа <code>textSnippet</code>, чтобы
          редактировать библиотеку фрагментов.
        </p>
      )}
    </section>
  );
}
