import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ChipEditorProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Array-of-strings editor with chip/pill rendering. Enter adds the current
 * input as a new chip; Backspace on an empty input removes the last chip;
 * clicking a chip edits it IN PLACE (Enter/blur commits, Escape cancels,
 * emptying it removes the chip). Used for `appMapping.titleIncludes` and the
 * launch-step args list.
 */
export function ChipEditor({
  values,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
}: ChipEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
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

  function startEdit(index: number) {
    if (disabled) return;
    setEditingIndex(index);
    setEditDraft(values[index]);
  }

  function commitEdit() {
    if (editingIndex === null) return;
    const trimmed = editDraft.trim();
    const next = [...values];
    if (!trimmed) {
      // Emptied → drop the chip.
      next.splice(editingIndex, 1);
    } else if (values.some((v, i) => i !== editingIndex && v === trimmed)) {
      // Edited into an existing value → drop this duplicate.
      next.splice(editingIndex, 1);
    } else {
      next[editingIndex] = trimmed;
    }
    onChange(next);
    setEditingIndex(null);
    setEditDraft("");
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditDraft("");
  }

  return (
    <div
      className={`chip-editor${disabled ? " chip-editor--disabled" : ""}`}
      onClick={() => {
        if (editingIndex === null) inputRef.current?.focus();
      }}
      role="group"
      aria-label={ariaLabel}
    >
      {values.map((v, i) => (
        <span key={`${i}-${v}`} className="chip-editor__chip">
          {editingIndex === i ? (
            <input
              className="chip-editor__chip-edit"
              type="text"
              value={editDraft}
              size={Math.max(editDraft.length, 4)}
              autoFocus
              disabled={disabled}
              aria-label={ariaLabel}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              onBlur={commitEdit}
            />
          ) : (
            <>
              <button
                type="button"
                className="chip-editor__chip-label chip-editor__chip-edit-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(i);
                }}
                disabled={disabled}
                title={t("common.edit")}
              >
                {v}
              </button>
              <button
                type="button"
                className="chip-editor__chip-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(i);
                }}
                aria-label={t("common.delete")}
                disabled={disabled}
              >
                ×
              </button>
            </>
          )}
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
