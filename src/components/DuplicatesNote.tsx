// The same thing on several buttons of the mouse shown: one quiet folded line
// under the mouse that opens the list; "Hide" remembers each group shown, so
// only a new duplicate brings the line back.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { duplicateKeys, type DuplicateIssue } from "../lib/config-check";
import { controlWithGesture, labelForLayer } from "../lib/labels";
import { ChevronIcon } from "./icons";

const HIDDEN_KEY = "sidearm.duplicatesNote.hidden";
// shortcut: keeps only the last hidden groups, one hidden long ago may show again.
const KEEP_HIDDEN = 200;

function hiddenKeys(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function DuplicatesNote({ duplicates }: { duplicates: DuplicateIssue[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(hiddenKeys);
  const keys = duplicateKeys(duplicates);
  if (keys.every((key) => hidden.includes(key))) return null;

  const hide = () => {
    const next = [...new Set([...hidden, ...keys])].slice(-KEEP_HIDDEN);
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the line comes back next start, nothing else breaks.
    }
  };

  return (
    <div className="duplicates-note panel__muted">
      <button type="button" className="action-button action-button--small action-button--ghost duplicates-note__toggle"
        aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronIcon open={open} />
        <span>{t("configCheck.duplicatesLine", { count: duplicates.length })}</span>
      </button>
      <button type="button" className="action-button action-button--small action-button--ghost" onClick={hide}>
        {t("configCheck.duplicatesHide")}
      </button>
      {open ? (
        <ul className="duplicates-note__list">
          {duplicates.map((issue, index) => (
            <li key={index}>
              {t("configCheck.duplicate", {
                name: issue.name,
                layer: labelForLayer(issue.bindings[0]!.layer),
                buttons: issue.bindings.map((b) => controlWithGesture(b.controlId, b.triggerMode)).join(", "),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
