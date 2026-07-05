import { useTranslation } from "react-i18next";

import { ModalHeader, ModalShell } from "./shared";

interface ShortcutRow {
  combo: string;
  desc: string;
}

/**
 * Keyboard-shortcut cheat-sheet, opened with `?` or from the command palette.
 * The combos are sourced from App's handleKeyDown / ProfilesWorkspace reorder so
 * this stays in lockstep with the real bindings — one place to read them all.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();

  const sections: { title: string; rows: ShortcutRow[] }[] = [
    {
      title: t("shortcuts.general"),
      rows: [
        { combo: "Ctrl+K", desc: t("shortcuts.palette") },
        { combo: "?", desc: t("shortcuts.help") },
        { combo: "Esc", desc: t("shortcuts.escape") },
      ],
    },
    {
      title: t("shortcuts.editing"),
      rows: [
        { combo: "Ctrl+Z", desc: t("shortcuts.undo") },
        { combo: "Ctrl+Y", desc: t("shortcuts.redo") },
        { combo: "Ctrl+N", desc: t("shortcuts.newProfile") },
        { combo: "Ctrl+Shift+A", desc: t("shortcuts.addRule") },
        { combo: "Ctrl+Shift+C", desc: t("shortcuts.captureWindow") },
      ],
    },
    {
      title: t("shortcuts.navigation"),
      rows: [
        { combo: "1 – 4", desc: t("shortcuts.tabs") },
        { combo: "← →", desc: t("shortcuts.moveControl") },
        { combo: "Enter", desc: t("shortcuts.openEditor") },
        { combo: "Delete", desc: t("shortcuts.clearBinding") },
        { combo: "Alt+↑ / Alt+↓", desc: t("shortcuts.reorderRule") },
      ],
    },
    {
      title: t("shortcuts.global"),
      rows: [{ combo: "Ctrl+Alt+N", desc: t("shortcuts.showHide") }],
    },
  ];

  return (
    <ModalShell
      onClose={onClose}
      className="shortcut-help"
      ariaLabelledby="shortcut-help-title"
    >
      <ModalHeader title={t("shortcuts.title")} id="shortcut-help-title" />
      <div className="shortcut-help__body">
        {sections.map((section) => (
          <section key={section.title} className="shortcut-help__section">
            <h3 className="shortcut-help__section-title">{section.title}</h3>
            <ul className="shortcut-help__list">
              {section.rows.map((row) => (
                <li key={row.desc} className="shortcut-help__row">
                  <span className="shortcut-help__keys">
                    <span className="command-palette__shortcut">{row.combo}</span>
                  </span>
                  <span className="shortcut-help__desc">{row.desc}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ModalShell>
  );
}
