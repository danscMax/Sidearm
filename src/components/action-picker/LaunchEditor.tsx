import { useTranslation } from "react-i18next";
import { ChipEditor } from "../ChipEditor";
import { ExecutablePathField } from "../ExecutablePathField";
import { DirectoryPathField } from "../DirectoryPathField";

export function LaunchEditor({
  draft,
  onChange,
}: {
  draft: { target: string; args: string[]; workingDir: string };
  onChange: (draft: { target: string; args: string[]; workingDir: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid">
      <ExecutablePathField
        label={t("picker.programLabel")}
        value={draft.target}
        onChange={(value) => onChange({ ...draft, target: value })}
        browseTitle={t("picker.launchBrowseProgram")}
        filterName={t("picker.launchBrowseFilter")}
        browseLabel={t("picker.launchBrowseBtn")}
      />
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
    </div>
  );
}
