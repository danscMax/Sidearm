import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
   Command Palette
   ───────────────────────────────────────────────────────── */

export const PALETTE_COMMANDS = [
  { id: "undo", label: "Отменить", shortcut: "Ctrl+Z" },
  { id: "redo", label: "Повторить", shortcut: "Ctrl+Y" },
  { id: "reload", label: "Загрузить с диска", shortcut: "" },
  { id: "tab-profiles", label: "Перейти: Профили", shortcut: "1" },
  { id: "tab-debug", label: "Перейти: Отладка", shortcut: "2" },
  { id: "tab-settings", label: "Перейти: Настройки", shortcut: "3" },
  { id: "layer-standard", label: "Слой: Стандартный", shortcut: "" },
  { id: "layer-hypershift", label: "Слой: Hypershift", shortcut: "" },
];

export function CommandPalette({
  onClose,
  onExecute,
}: {
  onClose: () => void;
  onExecute: (commandId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

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
          placeholder="Введите команду..."
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
          <div className="command-palette__empty">Ничего не найдено</div>
        )}
      </div>
    </div>
  );
}
