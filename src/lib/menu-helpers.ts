import type { MenuItem } from "./config";

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

/** A menu item's name; a line has none. */
export function menuItemLabel(item: MenuItem): string {
  return item.kind === "separator" ? "" : item.label;
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
