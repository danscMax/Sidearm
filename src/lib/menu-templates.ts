import type { TFunction } from "i18next";
import type { Action, AppConfig, MenuItem, ShortcutActionPayload } from "./config";
import { nextUniqueId } from "./config-editing";
import { collectMenuItemIds } from "./menu-helpers";
import { editedActions, withPhrase, type MenuEdits } from "./menu-phrase";

/** One ready item: a phrase (text, maybe Enter), keys, or a library snippet. */
type TemplateItem =
  | { label: string; text: string; enter?: boolean }
  | { label: string; keys: string }
  | { label: string; snippetId: string };

export interface MenuTemplate {
  id: string;
  name: string;
  items: TemplateItem[];
}

/** Typography: the label names the sign (i18n key), the text is what it types. */
const SYMBOLS: Array<[key: string, text: string]> = [
  ["emDash", "—"], ["enDash", "–"], ["quotes", "«»"], ["ellipsis", "…"], ["numero", "№"], ["arrow", "→"],
  ["bullet", "•"], ["times", "×"], ["approx", "≈"], ["plusMinus", "±"], ["degree", "°"], ["ruble", "₽"],
];

/** The ready-made menus offered for a new menu (and as blocks to add). */
export function menuTemplates(t: TFunction, config: AppConfig): MenuTemplate[] {
  const phrase = (key: string, enter = false) => ({ label: t(`menuTemplates.${key}.label`), text: t(`menuTemplates.${key}.text`), enter });
  const keys = (key: string, combo: string) => ({ label: t(`menuTemplates.${key}`), keys: combo });
  const templates: MenuTemplate[] = [
    {
      id: "agent",
      name: t("menuTemplates.agent"),
      items: [phrase("clarify"), phrase("docs"), phrase("continue", true), phrase("next", true), phrase("verify"), phrase("handoff")],
    },
    {
      id: "editing",
      name: t("menuTemplates.editing"),
      items: [
        keys("copy", "Ctrl+C"), keys("paste", "Ctrl+V"), keys("cut", "Ctrl+X"), keys("undo", "Ctrl+Z"),
        keys("redo", "Ctrl+Y"), keys("selectAll", "Ctrl+A"), keys("find", "Ctrl+F"),
      ],
    },
    {
      id: "windows",
      name: t("menuTemplates.windows"),
      items: [
        keys("snapLeft", "Win+Left"), keys("snapRight", "Win+Right"), keys("maximize", "Win+Up"), keys("switchWindow", "Alt+Tab"),
        keys("nextTab", "Ctrl+Tab"), keys("closeTab", "Ctrl+W"), keys("desktop", "Win+D"),
      ],
    },
    { id: "symbols", name: t("menuTemplates.symbols"), items: SYMBOLS.map(([key, text]) => ({ label: t(`menuTemplates.symbol.${key}`), text })) },
  ];
  if (config.snippetLibrary.length > 0) {
    templates.push({
      id: "library",
      name: t("menuTemplates.library"),
      // One item per distinct text: the library holds several copies of some.
      items: config.snippetLibrary
        .filter((snippet, index, all) => snippet.text.trim() && all.findIndex((other) => other.text.trim() === snippet.text.trim()) === index)
        .map((snippet) => ({ label: snippet.name, snippetId: snippet.id })),
    });
  }
  return templates;
}

/** "Ctrl+Shift+T" as a shortcut payload. */
function parseKeys(combo: string): ShortcutActionPayload {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  return { key, ctrl: mods.has("ctrl"), shift: mods.has("shift"), alt: mods.has("alt"), win: mods.has("win") };
}

/** The template as a new block at the end of the menu, with its own actions. */
export function addTemplate(
  config: AppConfig,
  edits: MenuEdits,
  items: MenuItem[],
  template: MenuTemplate,
): { items: MenuItem[]; edits: MenuEdits; blockId: string } {
  const actionIds = new Set(editedActions(config, edits).map((action) => action.id));
  const itemIds = new Set(collectMenuItemIds(items));
  const newActions: Record<string, Action> = {};
  const children: MenuItem[] = template.items.map((entry) => {
    const actionId = nextUniqueId(actionIds, `action-menu-${template.id}`);
    actionIds.add(actionId);
    const base = { id: actionId, displayName: entry.label };
    let action: Action;
    if ("keys" in entry) action = { ...base, type: "shortcut", payload: parseKeys(entry.keys) };
    else if ("snippetId" in entry) action = { ...base, type: "textSnippet", payload: { source: "libraryRef", snippetId: entry.snippetId } };
    else action = withPhrase({ ...base, type: "textSnippet", payload: { source: "inline", text: "", pasteMode: "sendText", tags: [] } }, entry.text, entry.enter ?? false);
    newActions[actionId] = action;
    const id = nextUniqueId(itemIds, "menu-item");
    itemIds.add(id);
    return { kind: "action", id, label: entry.label, actionId, enabled: true };
  });
  const blockId = nextUniqueId(itemIds, "menu-block");
  return {
    items: [...items, { kind: "submenu", id: blockId, label: template.name, enabled: true, items: children }],
    edits: { ...edits, actions: { ...edits.actions, ...newActions } },
    blockId,
  };
}
