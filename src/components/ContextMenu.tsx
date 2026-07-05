import { useLayoutEffect, useRef, useState } from "react";
import { useDismissable } from "../hooks/useDismissable";
import { useListKeyboard } from "../hooks/useListKeyboard";

interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: (ContextMenuItem | null)[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Close on outside-click or Escape (shared popover dismiss convention).
  useDismissable(menuRef, onClose);

  // The enabled, non-separator items — the only ones keyboard focus lands on.
  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(
      (entry): entry is { item: ContextMenuItem; index: number } =>
        entry.item !== null && !entry.item.disabled,
    );

  const onKeyDown = useListKeyboard({
    itemCount: selectable.length,
    activeIndex,
    setActiveIndex,
    onSelect: (selIndex) => {
      const target = selectable[selIndex];
      if (!target) return;
      target.item.onClick();
      onClose();
    },
    wrap: true,
  });

  // Clamp position to viewport bounds and move focus into the menu so arrow-key
  // navigation works immediately. Position is applied via the CSSOM (not an
  // inline style attribute) so it survives a strict CSP without 'unsafe-inline'.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    el.style.setProperty("--menu-left", `${Math.min(x, window.innerWidth - 200)}px`);
    el.style.setProperty(
      "--menu-top",
      `${Math.min(y, window.innerHeight - items.length * 36 - 16)}px`,
    );
    el.focus();
  }, [x, y, items.length]);

  const activeItem = selectable[activeIndex];
  const activeItemId = activeItem ? `context-menu-item-${activeItem.index}` : undefined;

  return (
    <div
      className="context-menu"
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-activedescendant={activeItemId}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        if (item === null) {
          return <div key={`sep-${i}`} className="context-menu__sep" role="separator" />;
        }
        const selIndex = selectable.findIndex((entry) => entry.index === i);
        const isActive = selIndex >= 0 && selIndex === activeIndex;
        return (
          <button
            key={`item-${i}`}
            id={`context-menu-item-${i}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`context-menu__item${item.danger ? " context-menu__item--danger" : ""}${item.disabled ? " context-menu__item--disabled" : ""}${isActive ? " context-menu__item--active" : ""}`}
            disabled={item.disabled}
            onMouseEnter={() => {
              if (selIndex >= 0) setActiveIndex(() => selIndex);
            }}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
