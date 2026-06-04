import { open } from "@tauri-apps/plugin-dialog";

/** Labelled text input paired with a native "browse for directory" button.
 *  Presentational: the caller owns how the chosen path is stored via `onChange`
 *  (which receives both manual edits and the picked directory). */
export function DirectoryPathField({
  label,
  value,
  onChange,
  browseTitle,
  browseLabel,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  browseTitle: string;
  browseLabel: string;
  placeholder?: string;
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
            const selected = await open({ title: browseTitle, directory: true, multiple: false });
            if (typeof selected === "string") {
              onChange(selected);
            }
          }}
        >
          {browseLabel}
        </button>
      </div>
    </label>
  );
}
