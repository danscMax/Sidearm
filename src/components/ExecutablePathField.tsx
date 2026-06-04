import { pickExecutablePath } from "../lib/backend";

const DEFAULT_EXE_EXTENSIONS = ["exe", "lnk", "bat", "cmd"];

/** Labelled text input paired with a native "browse for executable" button.
 *  Presentational: the caller owns how the chosen path is stored via `onChange`
 *  (which receives both manual edits and the picked path). */
export function ExecutablePathField({
  label,
  value,
  onChange,
  browseTitle,
  filterName,
  browseLabel,
  placeholder = "C:\\Program Files\\app.exe",
  extensions = DEFAULT_EXE_EXTENSIONS,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  browseTitle: string;
  filterName: string;
  browseLabel: string;
  placeholder?: string;
  extensions?: string[];
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <div className="field__row">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="action-button action-button--small"
          onClick={async () => {
            const pick = await pickExecutablePath({ title: browseTitle, filterName, extensions });
            if (pick) {
              onChange(pick.path);
            }
          }}
        >
          {browseLabel}
        </button>
      </div>
    </label>
  );
}
