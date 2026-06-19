/** Labelled text input paired with a native "browse" button. Presentational:
 *  the caller owns how the chosen path is stored via `onChange` (manual edits
 *  and picked path alike) and supplies the picker via `browse`. */
export function PathField({
  label,
  value,
  onChange,
  browse,
  browseLabel,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Opens the native picker; resolves to the chosen path, or null if cancelled. */
  browse: () => Promise<string | null>;
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
            const picked = await browse();
            if (picked) {
              onChange(picked);
            }
          }}
        >
          {browseLabel}
        </button>
      </div>
    </label>
  );
}
