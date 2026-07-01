import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChipEditor } from "../ChipEditor";
import { DirectoryPathField } from "../DirectoryPathField";
import { ExecutablePathField } from "../ExecutablePathField";

type LaunchDraft = { target: string; args: string[]; workingDir: string };
type LaunchTargetMode = "program" | "folder" | "url";

function inferTargetMode(target: string): LaunchTargetMode {
  const value = target.trim().toLowerCase();
  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("mailto:") ||
    value.startsWith("ftp://") ||
    value.startsWith("file://")
  ) {
    return "url";
  }
  return "program";
}

export function LaunchEditor({
  draft,
  onChange,
}: {
  draft: LaunchDraft;
  onChange: (draft: LaunchDraft) => void;
}) {
  const { t } = useTranslation();
  const [targetMode, setTargetMode] = useState<LaunchTargetMode>(() => inferTargetMode(draft.target));

  const handleModeChange = (mode: LaunchTargetMode) => {
    setTargetMode(mode);
    if (mode !== "program" && (draft.args.length > 0 || draft.workingDir.trim())) {
      onChange({ ...draft, args: [], workingDir: "" });
    }
  };

  return (
    <div className="editor-grid">
      <div className="settings-actions" role="group" aria-label={t("picker.launchTargetMode")}>
        {(["program", "folder", "url"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`action-button action-button--small${targetMode === mode ? "" : " action-button--ghost"}`}
            aria-pressed={targetMode === mode}
            onClick={() => handleModeChange(mode)}
          >
            {t(`picker.launchMode.${mode}`)}
          </button>
        ))}
      </div>

      {targetMode === "program" ? (
        <>
          <ExecutablePathField
            label={t("picker.programLabel")}
            value={draft.target}
            onChange={(value) => onChange({ ...draft, target: value })}
            browseTitle={t("picker.launchBrowseProgram")}
            filterName={t("picker.launchBrowseFilter")}
            browseLabel={t("picker.launchBrowseBtn")}
          />
          <p className="field__description">{t("picker.launchProgramHint")}</p>
          <div className="field">
            <span className="field__label">{t("picker.launchArgsLabel")}</span>
            <ChipEditor
              values={draft.args}
              onChange={(vals) => onChange({ ...draft, args: vals })}
              placeholder={t("picker.launchArgsPlaceholder")}
              ariaLabel={t("picker.launchArgsLabel")}
            />
          </div>
          <DirectoryPathField
            label={t("picker.launchWorkingDirLabel")}
            value={draft.workingDir}
            onChange={(value) => onChange({ ...draft, workingDir: value })}
            browseTitle={t("picker.launchBrowseDir")}
            browseLabel={t("picker.launchBrowseDirBtn")}
            placeholder={t("picker.launchWorkingDirPlaceholder")}
          />
        </>
      ) : null}

      {targetMode === "folder" ? (
        <>
          <DirectoryPathField
            label={t("picker.launchFolderLabel")}
            value={draft.target}
            onChange={(value) => onChange({ ...draft, target: value })}
            browseTitle={t("picker.launchBrowseDir")}
            browseLabel={t("picker.launchBrowseDirBtn")}
            placeholder={t("picker.launchFolderPlaceholder")}
          />
          <p className="field__description">{t("picker.launchFolderHint")}</p>
        </>
      ) : null}

      {targetMode === "url" ? (
        <label className="field">
          <span className="field__label">{t("picker.launchUrlLabel")}</span>
          <input
            type="text"
            value={draft.target}
            onChange={(e) => onChange({ ...draft, target: e.target.value })}
            placeholder={t("picker.launchUrlPlaceholder")}
            spellCheck={false}
          />
          <span className="field__description">{t("picker.launchUrlHint")}</span>
        </label>
      ) : null}
    </div>
  );
}
