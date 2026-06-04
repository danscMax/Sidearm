import type { MediaKeyKind } from "../../lib/config";
import { MEDIA_KEY_OPTIONS } from "../../lib/constants";

export function MediaKeyEditor({
  value,
  onChange,
}: {
  value: MediaKeyKind;
  onChange: (value: MediaKeyKind) => void;
}) {
  return (
    <div className="editor-grid">
      <div className="picker-grid">
        {MEDIA_KEY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`picker-grid__btn${value === opt.value ? " picker-grid__btn--active" : ""}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
