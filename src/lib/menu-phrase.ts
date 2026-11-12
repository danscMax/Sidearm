import type { Action, AppConfig, MenuItem, SnippetLibraryItem } from "./config";
import { nextUniqueId, upsertAction } from "./config-editing";
import { appendMenuItem, collectMenuItemIds, removeMenuItem } from "./menu-helpers";

/** A menu item's action seen as a phrase: the text it types, and whether
 *  Enter follows. `snippetId`: the text lives in that library snippet. */
export interface Phrase {
  text: string;
  enter: boolean;
  snippetId?: string;
}

/** Pause between the text and Enter, so a TUI does not take Enter as part of a paste. */
const ENTER_DELAY_MS = 80;

/** The phrase an action types, or null when it does something else. */
export function phraseOf(action: Action, library: SnippetLibraryItem[]): Phrase | null {
  if (action.type === "textSnippet") {
    const payload = action.payload;
    if (payload.source === "libraryRef") {
      const snippet = library.find((item) => item.id === payload.snippetId);
      return snippet ? { text: snippet.text, enter: false, snippetId: snippet.id } : null;
    }
    return { text: payload.text, enter: false };
  }
  if (action.type === "sequence") {
    const steps = action.payload.steps.filter((step) => step.type !== "sleep");
    const [first, second, ...rest] = steps;
    if (rest.length > 0 || first?.type !== "text") return null;
    if (!second) return { text: first.value, enter: false };
    return second.type === "send" && second.value.toLowerCase() === "enter" ? { text: first.value, enter: true } : null;
  }
  return null;
}

/** What a menu item does, as its editor shows it. */
export type ItemKind = "phrase" | "keys" | "other";

export function kindOf(action: Action | undefined, library: SnippetLibraryItem[]): ItemKind {
  if (!action) return "other";
  if (phraseOf(action, library)) return "phrase";
  return action.type === "shortcut" ? "keys" : "other";
}

/** The action typing `text` (then Enter when `enter`): text alone stays a text
 *  snippet, text + Enter is a two-step macro. Keeps id, name and conditions. */
export function withPhrase(action: Action, text: string, enter: boolean): Action {
  const { id, displayName, notes, conditions } = action;
  const base = { id, displayName, ...(notes ? { notes } : {}), ...(conditions ? { conditions } : {}) };
  if (enter) {
    return {
      ...base,
      type: "sequence",
      payload: { steps: [{ type: "text", value: text }, { type: "sleep", delayMs: ENTER_DELAY_MS }, { type: "send", value: "Enter" }] },
    };
  }
  const keep = action.type === "textSnippet" && action.payload.source === "inline" ? action.payload : null;
  return {
    ...base,
    type: "textSnippet",
    payload: { source: "inline", text, pasteMode: keep?.pasteMode ?? "sendText", tags: keep?.tags ?? [] },
  };
}

/** Changes the menu editor made to other actions and the library, applied on Save. */
export interface MenuEdits {
  /** Edited or new actions, by id. */
  actions: Record<string, Action>;
  /** New text of library snippets, by snippet id. */
  library: Record<string, string>;
}

export const NO_MENU_EDITS: MenuEdits = { actions: {}, library: {} };

/** The config's actions with the editor's edits on top (new ones last). */
export function editedActions(config: AppConfig, edits: MenuEdits): Action[] {
  const known = new Set(config.actions.map((action) => action.id));
  return [
    ...config.actions.map((action) => edits.actions[action.id] ?? action),
    ...Object.values(edits.actions).filter((action) => !known.has(action.id)),
  ];
}

export function editedLibrary(config: AppConfig, edits: MenuEdits): SnippetLibraryItem[] {
  return config.snippetLibrary.map((item) =>
    edits.library[item.id] != null ? { ...item, text: edits.library[item.id] } : item,
  );
}

function referencedActionIds(items: MenuItem[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: MenuItem[]) => list.forEach((item) => (item.kind === "action" ? ids.add(item.actionId) : walk(item.items)));
  walk(items);
  return ids;
}

/** Write the edits into the config: every edited action that exists, every new
 *  one the menu still uses (a phrase added then removed leaves nothing). */
export function applyMenuEdits(config: AppConfig, edits: MenuEdits, items: MenuItem[]): AppConfig {
  const known = new Set(config.actions.map((action) => action.id));
  const used = referencedActionIds(items);
  let next = config;
  for (const action of Object.values(edits.actions)) {
    if (known.has(action.id) || used.has(action.id)) next = upsertAction(next, action);
  }
  if (Object.keys(edits.library).length > 0) next = { ...next, snippetLibrary: editedLibrary(next, edits) };
  return next;
}

/** A new phrase item and its action (empty text, to be typed in). */
export function newPhrase(
  config: AppConfig,
  edits: MenuEdits,
  items: MenuItem[],
  label: string,
): { item: MenuItem; action: Action } {
  const actionId = nextUniqueId(editedActions(config, edits).map((action) => action.id), "action-menu-phrase");
  const action = withPhrase({ id: actionId, type: "textSnippet", displayName: label, payload: { source: "inline", text: "", pasteMode: "sendText", tags: [] } }, "", false);
  const item: MenuItem = { kind: "action", id: nextUniqueId(collectMenuItemIds(items), "menu-item"), label, actionId, enabled: true };
  return { item, action };
}

/** The items that keep the menu from being saved (their ids): an item or
 *  block without a name, a phrase that types nothing (whitespace only, as the
 *  backend's own check), or keys with neither a key nor a modifier. */
export function incompleteItems(config: AppConfig, edits: MenuEdits, items: MenuItem[]): string[] {
  const actions = new Map(editedActions(config, edits).map((action) => [action.id, action]));
  const library = editedLibrary(config, edits);
  const empty = (item: MenuItem): boolean => {
    if (item.label.trim() === "") return true;
    if (item.kind === "submenu") return false;
    const action = actions.get(item.actionId);
    if (action?.type === "shortcut") {
      const keys = action.payload;
      return keys.key.trim() === "" && !keys.ctrl && !keys.shift && !keys.alt && !keys.win;
    }
    const phrase = action ? phraseOf(action, library) : null;
    return phrase != null && phrase.text.trim() === "";
  };
  const found: string[] = [];
  const walk = (list: MenuItem[]) => list.forEach((item) => {
    if (empty(item)) found.push(item.id);
    if (item.kind === "submenu") walk(item.items);
  });
  walk(items);
  return found;
}

/** Whether the menu cannot be saved yet (see [`incompleteItems`]). */
export function isMenuIncomplete(config: AppConfig, edits: MenuEdits, items: MenuItem[]): boolean {
  return incompleteItems(config, edits, items).length > 0;
}

/** Move an item one place up (-1) or down (+1) among its siblings. */
export function moveMenuItem(items: MenuItem[], targetId: string, delta: -1 | 1): MenuItem[] {
  const index = items.findIndex((item) => item.id === targetId);
  if (index >= 0) {
    const to = index + delta;
    if (to < 0 || to >= items.length) return items;
    const next = [...items];
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  }
  return items.map((item) => (item.kind === "submenu" ? { ...item, items: moveMenuItem(item.items, targetId, delta) } : item));
}

/** The id of the submenu holding `targetId`, null at the top, undefined if absent. */
export function parentOf(items: MenuItem[], targetId: string, parent: string | null = null): string | null | undefined {
  for (const item of items) {
    if (item.id === targetId) return parent;
    if (item.kind === "submenu") {
      const found = parentOf(item.items, targetId, item.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Move an item to the end of another submenu (`null` = the top level).
 *  A submenu left empty goes away, as when its last item is deleted. */
export function moveMenuItemTo(items: MenuItem[], targetId: string, parentId: string | null): MenuItem[] {
  const find = (list: MenuItem[]): MenuItem | undefined => {
    for (const item of list) {
      if (item.id === targetId) return item;
      const inner = item.kind === "submenu" ? find(item.items) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  const item = find(items);
  if (!item || parentOf(items, targetId) === parentId || item.id === parentId) return items;
  return appendMenuItem(removeMenuItem(items, targetId), parentId, item);
}
