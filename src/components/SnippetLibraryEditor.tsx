import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      <p className="panel__eyebrow">{t("snippet.eyebrow")}</p>
      {selectedAction &&
      selectedAction.type === "textSnippet" &&
      "source" in selectedAction.payload ? (
        selectedAction.payload.source === "libraryRef" ? (
          selectedSnippet ? (
            <div className="editor-grid">
              <div className="field">
                <span className="field__label">{t("snippet.id")}</span>
                <code className="field__static">{selectedSnippet.id}</code>
              </div>

              <label className="field">
                <span className="field__label">{t("snippet.name")}</span>
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
                <span className="field__label">{t("snippet.text")}</span>
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
                <span className="field__label">{t("snippet.pasteMode")}</span>
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
                  <option value="clipboardPaste">{t("snippet.pasteModeClipboard")}</option>
                  <option value="sendText">{t("snippet.pasteModeDirect")}</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">{t("inspector.tags")}</span>
                <input
                  type="text"
                  value={selectedSnippet.tags.join(", ")}
                  placeholder="tag1, tag2, tag3"
                  onChange={(event) => {
                    updateSelectedSnippetDraft((snippet) => ({
                      ...snippet,
                      tags: parseCommaSeparatedUniqueValues(event.target.value),
                    }));
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">{t("snippet.notes")}</span>
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
                {t("snippet.usageCount", { count: selectedSnippetUsageCount })}
              </p>
            </div>
          ) : (
            <div className="notice notice--error">
              <strong>{t("snippet.notFound")}</strong>
              <p>
                {t("snippet.notFoundBody")}
              </p>
            </div>
          )
        ) : (
          <p className="panel__muted">
            {t("snippet.inlineMessage")}
          </p>
        )
      ) : (
        <p className="panel__muted">
          {t("snippet.empty")}
        </p>
      )}
    </section>
  );
}
