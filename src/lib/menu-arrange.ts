// Arranging a menu's items: drop one before / after / inside another, a level
// in or out, copies with fresh ids, and where a text is used across all menus.

import type { Action, AppConfig, MenuItem } from "./config";
import { nextUniqueId } from "./config-editing";
import { collectMenuItemIds, removeMenuItem } from "./menu-helpers";
import { editedActions, editedLibrary, parentOf, phraseOf, type MenuEdits } from "./menu-phrase";

export type DropPlace = "before" | "after" | "inside";

function find(items: MenuItem[], id: string): MenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = item.kind === "submenu" ? find(item.items, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Insert `item` next to (or at the end of) `targetId` in a tree. */
function insertAt(items: MenuItem[], targetId: string, place: DropPlace, item: MenuItem): MenuItem[] {
  const out: MenuItem[] = [];
  for (const current of items) {
    if (current.id === targetId && place === "before") out.push(item);
    if (current.id === targetId && place === "inside" && current.kind === "submenu") {
      out.push({ ...current, items: [...current.items, item] });
    } else {
      out.push(current.kind === "submenu" ? { ...current, items: insertAt(current.items, targetId, place, item) } : current);
    }
    if (current.id === targetId && place === "after") out.push(item);
  }
  return out;
}

/** Move `draggedId` before, after or into `targetId`. Nothing moves into itself
 *  or its own descendants, and "inside" needs a submenu. A submenu left empty goes away. */
export function placeMenuItem(items: MenuItem[], draggedId: string, targetId: string, place: DropPlace): MenuItem[] {
  const dragged = find(items, draggedId);
  const target = find(items, targetId);
  if (!dragged || !target || draggedId === targetId) return items;
  if (dragged.kind === "submenu" && find(dragged.items, targetId)) return items;
  if (place === "inside" && target.kind !== "submenu") return items;
  // Insert first, then remove the original: removing first could empty (and
  // so drop) the very list the item is placed next to.
  const moved = insertAt(items, targetId, place, { ...dragged, id: MOVING });
  const rename = (list: MenuItem[]): MenuItem[] =>
    list.map((item) => (item.id === MOVING ? { ...item, id: draggedId } : item.kind === "submenu" ? { ...item, items: rename(item.items) } : item));
  return rename(removeMenuItem(moved, draggedId));
}

const MOVING = "\u0000moving";

/** A level out: right after the submenu holding it. */
export function outdentMenuItem(items: MenuItem[], id: string): MenuItem[] {
  const parent = parentOf(items, id);
  return parent ? placeMenuItem(items, id, parent, "after") : items;
}

/** A level in: to the end of the submenu just above it. */
export function indentMenuItem(items: MenuItem[], id: string): MenuItem[] {
  const parent = parentOf(items, id);
  const siblings = parent ? (find(items, parent) as Extract<MenuItem, { kind: "submenu" }>).items : items;
  const above = siblings[siblings.findIndex((item) => item.id === id) - 1];
  return above?.kind === "submenu" ? placeMenuItem(items, id, above.id, "inside") : items;
}

/**
 * A copy of `item` for `intoItems` (this or another menu): fresh item ids, and
 * a fresh action for each phrase or keys item so editing one copy leaves the
 * other alone (a library text stays shared: the library holds it). Other
 * actions are referenced as they are.
 */
export function cloneMenuItem(
  config: AppConfig,
  edits: MenuEdits,
  item: MenuItem,
  intoItems: MenuItem[],
): { item: MenuItem; edits: MenuEdits } {
  const itemIds = new Set(collectMenuItemIds(intoItems));
  const actionIds = new Set(editedActions(config, edits).map((action) => action.id));
  const actions = new Map(editedActions(config, edits).map((action) => [action.id, action]));
  const library = editedLibrary(config, edits);
  const added: Record<string, Action> = {};
  const copy = (current: MenuItem): MenuItem => {
    const id = nextUniqueId(itemIds, `${current.id}-copy`);
    itemIds.add(id);
    if (current.kind === "submenu") return { ...current, id, items: current.items.map(copy) };
    const action = actions.get(current.actionId);
    if (!action || (action.type !== "shortcut" && !phraseOf(action, library))) return { ...current, id };
    const actionId = nextUniqueId(actionIds, `${action.id}-copy`);
    actionIds.add(actionId);
    added[actionId] = { ...structuredClone(action), id: actionId };
    return { ...current, id, actionId };
  };
  const cloned = copy(item);
  return { item: cloned, edits: { ...edits, actions: { ...edits.actions, ...added } } };
}

/**
 * The prompts a text file holds: its fenced blocks of at least 200 characters
 * (a how-to page with the prompt in a code block), else the whole text.
 * Several blocks give several prompts, named "name · 1", "name · 2"…
 */
export function promptsFromFile(name: string, text: string): { label: string; text: string }[] {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map((match) => match[1]!.trim()).filter((block) => block.length >= 200);
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || name;
  if (blocks.length === 0) return text.trim() ? [{ label: name, text: text.trim() }] : [];
  if (blocks.length === 1) return [{ label: title, text: blocks[0]! }];
  return blocks.map((block, index) => ({ label: `${title} · ${index + 1}`, text: block }));
}

export interface MenuHit {
  menuId: string;
  menuName: string;
  /** Labels from the menu's top level down to the item. */
  path: string[];
  itemId: string;
}

/** Every item of every menu whose name or sent text contains `query`
 *  (the menu being edited uses its edited `items`). */
export function searchMenus(
  config: AppConfig,
  edits: MenuEdits,
  query: string,
  current?: { menuId?: string; items: MenuItem[] },
): MenuHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const actions = editedActions(config, edits);
  const byId = new Map(actions.map((action) => [action.id, action]));
  const library = editedLibrary(config, edits);
  const hits: MenuHit[] = [];
  const menus = actions.filter((action) => action.type === "menu" && action.id !== current?.menuId);
  const walk = (menuId: string, menuName: string, list: MenuItem[], path: string[]) => {
    for (const item of list) {
      const here = [...path, item.label];
      const action = item.kind === "action" ? byId.get(item.actionId) : undefined;
      const text = action ? phraseOf(action, library)?.text ?? "" : "";
      if (item.label.toLowerCase().includes(needle) || text.toLowerCase().includes(needle)) {
        hits.push({ menuId, menuName, path: here, itemId: item.id });
      }
      if (item.kind === "submenu") walk(menuId, menuName, item.items, here);
    }
  };
  if (current) walk(current.menuId ?? "", "", current.items, []);
  for (const menu of menus) {
    if (menu.type === "menu") walk(menu.id, menu.displayName, menu.payload.items, []);
  }
  return hits;
}

/** The other menus that run `actionId` or type the same library text: "Menu › Block › Item". */
export function otherMenuUses(config: AppConfig, edits: MenuEdits, actionId: string, menuId?: string): string[] {
  const actions = editedActions(config, edits);
  const library = editedLibrary(config, edits);
  const byId = new Map(actions.map((action) => [action.id, action]));
  const own = byId.get(actionId);
  const snippet = own ? phraseOf(own, library)?.snippetId : undefined;
  const uses: string[] = [];
  const walk = (menuName: string, list: MenuItem[], path: string[]) => {
    for (const item of list) {
      if (item.kind === "submenu") { walk(menuName, item.items, [...path, item.label]); continue; }
      const action = byId.get(item.actionId);
      const sameSnippet = snippet && action && phraseOf(action, library)?.snippetId === snippet;
      if (item.actionId === actionId || sameSnippet) uses.push([menuName, ...path, item.label].join(" › "));
    }
  };
  for (const menu of actions) {
    if (menu.type === "menu" && menu.id !== menuId) walk(menu.displayName, menu.payload.items, []);
  }
  return uses;
}
