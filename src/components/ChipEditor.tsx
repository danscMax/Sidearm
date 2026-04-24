import { useRef, useState } from "react";

export interface ChipEditorProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Array-of-strings editor with chip/pill rendering. Enter adds the current
 * input as a new chip; Backspace on an empty input removes the last chip.
 * Used for `appMapping.titleIncludes` and the launch-step args list.
 */
export function ChipEditor({
  values,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
}: ChipEditorProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  }

  function removeAt(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  return (
    <div
      className={`chip-editor${disabled ? " chip-editor--disabled" : ""}`}
      onClick={() => inputRef.current?.focus()}
      role="group"
      aria-label={ariaLabel}
    >
      {values.map((v, i) => (
        <span key={`${i}-${v}`} className="chip-editor__chip">
          <span className="chip-editor__chip-label">{v}</span>
          <button
            type="button"
            className="chip-editor__chip-remove"
            onClick={(e) => {
              e.stopPropagation();
              removeAt(i);
            }}
            aria-label="Remove"
            disabled={disabled}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="chip-editor__input"
        type="text"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
      />
    </div>
  );
}
