import type { RefObject } from "react";

import { pickExecutablePath } from "../lib/backend";

interface ExeMatchFieldProps {
  /** Visible field label. */
  label: string;
  /** Current exe basename (e.g. "chrome.exe"). */
  exe: string;
  /** Optional full process path; rendered as a mono caption when
   *  `showProcessPath` is set. */
  processPath?: string;
  /**
   * Report a new exe + optional full path. Typing reports `(value, undefined)`
   * (clearing any captured path); Browse reports `(name, path)` from the picker.
   */
  onChange: (exe: string, processPath?: string) => void;
  placeholder: string;
  /** Dialog title / filter / button copy for the Browse picker. */
  browseTitle: string;
  browseFilter: string;
  browseLabel: string;
  /** Optional ref to the text input (e.g. for auto-focus). */
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /** Submit affordance — invoked on Enter in the text input. */
  onEnter?: () => void;
  /** When provided, render a "pick running process" button wired to this. */
  onPickRunning?: () => void;
  pickRunningLabel?: string;
  pickRunningTooltip?: string;
  /** Render the captured process-path caption below the row. */
  showProcessPath?: boolean;
}

/**
 * Labelled executable-match field: an exe-basename text input plus a Browse
 * button that captures BOTH the basename and the full path, with optional
 * "pick running process" affordance and a process-path caption. Shared by the
 * app-mapping editor and the new-rule dialog so both capture processPath the
 * same way. (Distinct from PathField/ExecutablePathField, which are
 * full-path-only.)
 */
export function ExeMatchField({
  label,
  exe,
  processPath,
  onChange,
  placeholder,
  browseTitle,
  browseFilter,
  browseLabel,
  inputRef,
  autoFocus,
  onEnter,
  onPickRunning,
  pickRunningLabel,
  pickRunningTooltip,
  showProcessPath,
}: ExeMatchFieldProps) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="field__row">
        <input
          ref={inputRef}
          type="text"
          autoFocus={autoFocus}
          value={exe}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value, undefined)}
          onKeyDown={
            onEnter
              ? (e) => {
                  if (e.key === "Enter" && exe.trim()) onEnter();
                }
              : undefined
          }
        />
        <button
          type="button"
          className="action-button action-button--small"
          onClick={async () => {
            const pick = await pickExecutablePath({
              title: browseTitle,
              filterName: browseFilter,
              extensions: ["exe", "lnk"],
            });
            if (pick) {
              onChange(pick.name, pick.path);
            }
          }}
        >
          {browseLabel}
        </button>
        {onPickRunning ? (
          <button
            type="button"
            className="action-button action-button--small"
            onClick={onPickRunning}
            title={pickRunningTooltip}
          >
            {pickRunningLabel}
          </button>
        ) : null}
      </div>
      {showProcessPath && processPath ? (
        <p
          className="field__description field__description--mono"
          title={processPath}
        >
          {processPath}
        </p>
      ) : null}
    </div>
  );
}
