import { isMenuMark, type MenuItem } from "./config";

export function collectMenuItemIds(items: MenuItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "submenu"
      ? [item.id, ...collectMenuItemIds(item.items)]
      : [item.id],
  );
}

/** `nextItem` right after item `afterId` in that item's list (at the end of
 *  the menu when there is no such item). */
export function insertMenuItemAfter(items: MenuItem[], afterId: string | null, nextItem: MenuItem): MenuItem[] {
  let placed = false;
  const walk = (list: MenuItem[]): MenuItem[] => list.flatMap((item) => {
    if (item.id === afterId) {
      placed = true;
      return [item, nextItem];
    }
    return [item.kind === "submenu" ? { ...item, items: walk(item.items) } : item];
  });
  const out = walk(items);
  return placed ? out : [...items, nextItem];
}

/** The items with the popup's search box, first when the menu had none (as
 *  the popup always drew it; the backend's `migrate_menu_search` does the
 *  same on load), so the editor can move it, turn it off or set its scope. */
export function withSearchItem(items: MenuItem[]): MenuItem[] {
  if (items.some((item) => item.kind === "search")) return items;
  const ids = new Set(collectMenuItemIds(items));
  let id = "menu-search";
  while (ids.has(id)) id += "-";
  return [{ kind: "search", id, enabled: true, allMenus: true }, ...items];
}

/** The search box inside a block or list: the popup draws it only among the
 *  top-level items, so an arrangement that puts it there is refused. */
export function searchNested(items: MenuItem[]): boolean {
  return items.some((item) => item.kind === "submenu" && (item.items.some((inner) => inner.kind === "search") || searchNested(item.items)));
}

/** A menu item's name; a line and the search box have none. */
export function menuItemLabel(item: MenuItem): string {
  return isMenuMark(item) ? "" : item.label;
}

export function appendMenuItem(
  items: MenuItem[],
  parentId: string | null,
  nextItem: MenuItem,
): MenuItem[] {
  if (parentId === null) {
    return [...items, nextItem];
  }

  return items.map((item) => {
    if (item.kind === "submenu") {
      if (item.id === parentId) {
        return {
          ...item,
          items: [...item.items, nextItem],
        };
      }

      return {
        ...item,
        items: appendMenuItem(item.items, parentId, nextItem),
      };
    }

    return item;
  });
}

export function updateMenuItem(
  items: MenuItem[],
  targetId: string,
  updateItem: (item: MenuItem) => MenuItem,
): MenuItem[] {
  return items.map((item) => {
    if (item.id === targetId) {
      return updateItem(item);
    }

    if (item.kind === "submenu") {
      return {
        ...item,
        items: updateMenuItem(item.items, targetId, updateItem),
      };
    }

    return item;
  });
}

export function removeMenuItem(items: MenuItem[], targetId: string): MenuItem[] {
  return items
    .filter((item) => item.id !== targetId)
    .map((item) =>
      item.kind === "submenu"
        ? {
            ...item,
            items: removeMenuItem(item.items, targetId),
          }
        : item,
    )
    .filter((item) => !(item.kind === "submenu" && item.items.length === 0));
}
