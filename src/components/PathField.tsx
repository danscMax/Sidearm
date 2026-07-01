import { useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const picked = await browse();
              if (picked) {
                onChange(picked);
              }
            } catch {
              setError(t("common.browseFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("common.processing") : browseLabel}
        </button>
      </div>
      {error ? <span className="field__description">{error}</span> : null}
    </label>
  );
}
