import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/* ─────────────────────────────────────────────────────────
   Command Palette
   ───────────────────────────────────────────────────────── */

export function CommandPalette({
  onClose,
  onExecute,
}: {
  onClose: () => void;
  onExecute: (commandId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const PALETTE_COMMANDS = [
    { id: "undo", label: t("command.undo"), shortcut: "Ctrl+Z" },
    { id: "redo", label: t("command.redo"), shortcut: "Ctrl+Y" },
    { id: "reload", label: t("command.reload"), shortcut: "" },
    { id: "tab-profiles", label: t("command.gotoProfiles"), shortcut: "1" },
    { id: "tab-debug", label: t("command.gotoDebug"), shortcut: "2" },
    { id: "tab-settings", label: t("command.gotoSettings"), shortcut: "3" },
    { id: "layer-standard", label: t("command.layerStandard"), shortcut: "" },
    { id: "layer-hypershift", label: t("command.layerHypershift"), shortcut: "" },
  ];

  const filtered = PALETTE_COMMANDS.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      onExecute(filtered[activeIndex].id);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <input
          className="command-palette__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("command.placeholder")}
          autoFocus
        />
        {filtered.length > 0 ? (
          <ul className="command-palette__list" role="listbox">
            {filtered.map((cmd, index) => (
              <li
                key={cmd.id}
                role="option"
                aria-selected={index === activeIndex}
                className={`command-palette__item${index === activeIndex ? " command-palette__item--active" : ""}`}
                onClick={() => onExecute(cmd.id)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut ? <span className="command-palette__shortcut">{cmd.shortcut}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="command-palette__empty">{t("command.empty")}</div>
        )}
      </div>
    </div>
  );
}
