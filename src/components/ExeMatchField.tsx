import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { normalizeCommandError, pickExecutablePath, resolveShortcutTarget } from "../lib/backend";

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
  const { t } = useTranslation();
  // Why the picked file cannot be a rule's program (not an .exe, a shortcut to something else).
  const [pickError, setPickError] = useState<string | null>(null);
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="field__row">
        <input
          ref={inputRef}
          aria-label={label}
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
            try {
              const pick = await pickExecutablePath({
                title: browseTitle,
                filterName: browseFilter,
                extensions: ["exe", "lnk"],
              });
              if (!pick) return;
              const lower = pick.name.toLowerCase();
              if (lower.endsWith(".lnk")) {
                // A shortcut (a Start menu entry): the rule matches the program it starts.
                try {
                  const target = await resolveShortcutTarget(pick.path);
                  setPickError(null);
                  onChange(target.split(/[\\/]/).pop() ?? target, target);
                } catch (error) {
                  setPickError(normalizeCommandError(error).message);
                }
                return;
              }
              const valid = lower.endsWith(".exe");
              setPickError(valid ? null : t("newRule.exeOrShortcut"));
              if (valid) onChange(pick.name, pick.path);
            } catch {
              // Dialog plugin failure: treat like a cancelled pick instead of
              // an unhandled rejection (audit honorable mention).
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
      {pickError ? <p role="alert" className="panel__muted">{pickError}</p> : null}
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
