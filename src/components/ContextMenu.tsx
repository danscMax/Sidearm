import { useLayoutEffect, useRef } from "react";
import { useDismissable } from "../hooks/useDismissable";

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

  // Close on outside-click or Escape (shared popover dismiss convention).
  useDismissable(menuRef, onClose);

  // Clamp position to viewport bounds. Applied via the CSSOM (not an inline
  // style attribute) so it survives a strict CSP without 'unsafe-inline' (P2-3).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    el.style.setProperty("--menu-left", `${Math.min(x, window.innerWidth - 200)}px`);
    el.style.setProperty(
      "--menu-top",
      `${Math.min(y, window.innerHeight - items.length * 36 - 16)}px`,
    );
  }, [x, y, items.length]);

  return (
    <div className="context-menu" ref={menuRef}>
      {items.map((item, i) => {
        if (item === null) {
          return <div key={`sep-${i}`} className="context-menu__sep" />;
        }
        return (
          <button
            key={`item-${i}`}
            type="button"
            className={`context-menu__item${item.danger ? " context-menu__item--danger" : ""}${item.disabled ? " context-menu__item--disabled" : ""}`}
            disabled={item.disabled}
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
