import type { MenuItem } from "./config";

export function collectMenuItemIds(items: MenuItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "submenu"
      ? [item.id, ...collectMenuItemIds(item.items)]
      : [item.id],
  );
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
