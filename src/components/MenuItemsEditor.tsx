import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Action, AppConfig, MenuItem } from "../lib/config";
import { nextUniqueId } from "../lib/config-editing";
import { displayNameForControlId } from "../lib/labels";
import { appendMenuItem, collectMenuItemIds, removeMenuItem, updateMenuItem } from "../lib/menu-helpers";
import {
  editedActions, editedLibrary, incompleteItems, kindOf, moveMenuItem, moveMenuItemTo, newPhrase, parentOf, phraseOf, withPhrase,
  type ItemKind, type MenuEdits,
} from "../lib/menu-phrase";
import { addTemplate, menuTemplates, type MenuTemplate } from "../lib/menu-templates";
import {
  cloneMenuItem, indentMenuItem, otherMenuUses, outdentMenuItem, placeMenuItem, promptsFromFile, searchMenus, type DropPlace,
} from "../lib/menu-arrange";
import { getMenuUsage, getPressLog, normalizeCommandError, pickTextFolder } from "../lib/backend";
import { sumDays, unpickedItems, type PressLog } from "../lib/press-stats";
import { ShortcutEditor } from "./action-picker/ShortcutEditor";
import { PillTrack } from "./PillTrack";
import { ContextMenu, type ContextMenuProps } from "./ContextMenu";
import { HelpTip, SelectField, Toggle } from "./shared";

/** Items a side button picks by number in the popup. */
const NUMBERED = 12;
const NO_BLOCK = "";
const MENU_DRAG_TYPE = "application/x-sidearm-menu-item";

export interface MenuItemsEditorProps {
  items: MenuItem[];
  /** The item selected on open (the popup's right click → Edit). */
  initialSelectedId?: string;
  onChange: (items: MenuItem[]) => void;
  config: AppConfig;
  /** Phrase texts and new actions edited here, written on Save. */
  edits: MenuEdits;
  onEditsChange: (edits: MenuEdits) => void;
  /** The menu's own action: never offered as one of its items. */
  menuActionId?: string;
  disabled?: boolean;
  /** The menu's name, edited in the editor's top bar (the picker's name field). */
  name?: string;
  namePlaceholder?: string;
  onNameChange?: (name: string) => void;
  /** How many other buttons open this same menu: a chip in the top bar. */
  sharedUses?: number;
}

/** The button number of each item as the popup shows it: the top level and
 *  its blocks (top-level submenus) count on together; a submenu inside a block
 *  is its own level and counts from 1. */
function numbering(items: MenuItem[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const level = (list: MenuItem[]) => list.forEach((item, index) => {
    numbers.set(item.id, index + 1);
    if (item.kind === "submenu") level(item.items);
  });
  let next = 1;
  for (const item of items) {
    if (item.kind === "submenu") {
      for (const inner of item.items) {
        numbers.set(inner.id, next++);
        if (inner.kind === "submenu") level(inner.items);
      }
    } else {
      numbers.set(item.id, next++);
    }
  }
  return numbers;
}

function findItem(items: MenuItem[], id: string | null): MenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = item.kind === "submenu" ? findItem(item.items, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Another action to run: a filter box over the actions, grouped by type. */
function ActionList({ actions, value, onChange, disabled }: { actions: Action[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = actions.filter((action) => !needle || action.displayName.toLowerCase().includes(needle));
  const types = [...new Set(shown.map((action) => action.type))];
  return (
    <div className="menu-ed__actions">
      <input className="input" type="search" value={query} disabled={disabled} placeholder={t("inspector.menuFindAction")}
        aria-label={t("inspector.menuFindAction")} onChange={(event) => setQuery(event.target.value)} />
      <div className="menu-ed__action-list" role="listbox" aria-label={t("inspector.menuOtherAction")}>
        {types.map((type) => (
          <div key={type}>
            <div className="menu-ed__action-type">{t(`action.type.${type}`)}</div>
            {shown.filter((action) => action.type === type).map((action) => (
              <button key={action.id} type="button" role="option" aria-selected={action.id === value} disabled={disabled}
                className={`menu-ed__action${action.id === value ? " menu-ed__action--on" : ""}`} onClick={() => onChange(action.id)}>
                {action.displayName}
              </button>
            ))}
          </div>
        ))}
        {shown.length === 0 ? <p className="menu-ed__note">{t("inspector.menuNothingFound")}</p> : null}
      </div>
    </div>
  );
}

/**
 * The items of a `menu` action, master–detail: on the left the menu as the
 * popup shows it (blocks, button numbers) with the add bar under it, on the
 * right the selected item — a phrase (its text, Enter), keys (recorded here),
 * or another action; its block and order.
 */
/** The labels from the menu's top level down to item `id`. */
function pathTo(items: MenuItem[], id: string, path: string[] = []): string[] {
  for (const item of items) {
    if (item.id === id) return [...path, item.label];
    if (item.kind === "submenu") {
      const inner = pathTo(item.items, id, [...path, item.label]);
      if (inner.length) return inner;
    }
  }
  return [];
}

export function MenuItemsEditor({
  items, initialSelectedId, onChange, config, edits, onEditsChange, menuActionId, disabled, name, namePlaceholder, onNameChange, sharedUses,
}: MenuItemsEditorProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? items[0]?.id ?? null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: DropPlace } | null>(null);
  const [query, setQuery] = useState("");
  // The last removal, offered back while neither draft changed since.
  const [removed, setRemoved] = useState<{ before: MenuItem[]; after: MenuItem[]; editsBefore: MenuEdits; editsAfter: MenuEdits; label: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The item's menu (right click or ⋯); `to`: the menus to copy or move it to.
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; to?: "copy" | "move" } | null>(null);
  // "Copy to menu…" swaps the menu's items: the close that follows its click must not shut it.
  const keepCtx = useRef(false);
  // "+ Add ▾" in the top bar: where its menu opens.
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null);
  // Blocks folded in the tree (this session only).
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (id: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const ctxItem = ctx ? findItem(items, ctx.id) : undefined;
  const openCtx = (event: React.MouseEvent, item: MenuItem) => {
    event.preventDefault();
    setSelectedId(item.id);
    setCtx({ x: event.clientX, y: event.clientY, id: item.id });
  };
  // Picks per action id from the popup, to see what is used and what is not.
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    getMenuUsage().then((counts) => { if (live) setUsage(counts); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const actions = editedActions(config, edits);
  const library = editedLibrary(config, edits);
  const otherActions = actions.filter((action) => action.id !== menuActionId && action.type !== "disabled");
  const otherMenus = otherActions.filter((action) => action.type === "menu");
  const hits = searchMenus(config, edits, query, { menuId: menuActionId, items });
  // "Not picked for 30 days": this menu's items whose action never ran (press log).
  const [unpickedOnly, setUnpickedOnly] = useState(false);
  const [pressLog, setPressLog] = useState<PressLog | null>(null);
  useEffect(() => {
    if (!unpickedOnly || pressLog) return;
    let live = true;
    getPressLog().then((log) => { if (live) setPressLog(log); }).catch(() => {});
    return () => { live = false; };
  }, [unpickedOnly, pressLog]);
  const unpicked = unpickedOnly && pressLog
    ? unpickedItems(items, sumDays(pressLog, 30, new Date()), new Map(actions.map((action) => [action.id, action])))
    : null;
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const profileName = new Map(config.profiles.map((profile) => [profile.id, profile.name]));
  const numbers = numbering(items);
  const blocks = items.filter((item) => item.kind === "submenu");
  const selected = findItem(items, selectedId) ?? items[0];
  const templates = menuTemplates(t, config);
  // What keeps Save off: shown, so a disabled Save is never a mystery.
  const missing = new Set(incompleteItems(config, edits, items));

  function putAction(action: Action, nextEdits: MenuEdits = edits): MenuEdits {
    return { ...nextEdits, actions: { ...nextEdits.actions, [action.id]: action } };
  }

  function setPhrase(action: Action, text: string, enter: boolean) {
    const phrase = phraseOf(action, library);
    // A library text stays linked while Enter is off: the library holds it.
    if (phrase?.snippetId && !enter) {
      onEditsChange({ ...edits, library: { ...edits.library, [phrase.snippetId]: text } });
      return;
    }
    onEditsChange(putAction(withPhrase(action, text, enter)));
  }

  function newActionId(base: string): string {
    return nextUniqueId(actions.map((action) => action.id), base);
  }

  /** Where a new item goes: the selected block or submenu, or the one holding the selected item. */
  function targetParent(): string | null {
    if (!selected) return null;
    if (selected.kind === "submenu") return selected.id;
    return parentOf(items, selected.id) ?? null;
  }

  function insert(item: MenuItem, parentId: string | null, nextEdits?: MenuEdits) {
    if (nextEdits) onEditsChange(nextEdits);
    onChange(appendMenuItem(items, parentId, item));
    setSelectedId(item.id);
  }

  function addPhrase() {
    const { item, action } = newPhrase(config, edits, items, t("inspector.menuNewPhrase"));
    insert(item, targetParent(), putAction(action));
  }

  function addKeys() {
    const action: Action = { id: newActionId("action-menu-keys"), displayName: t("inspector.menuNewKeys"), type: "shortcut", payload: { key: "", ctrl: false, shift: false, alt: false, win: false } };
    insert({ kind: "action", id: nextUniqueId(collectMenuItemIds(items), "menu-item"), label: action.displayName, actionId: action.id, enabled: true }, targetParent(), putAction(action));
  }

  /** A block at the top level, or a list (opens as its own level) inside the block in use. */
  function addGroup(asList: boolean) {
    const { item: child, action } = newPhrase(config, edits, items, t("inspector.menuNewPhrase"));
    const ids = [...collectMenuItemIds(items), child.id];
    let parentId = asList ? targetParent() : null;
    let nextItems = items;
    // A list needs a block to live in (a top-level submenu is a block).
    if (asList && parentId === null) {
      parentId = nextUniqueId(ids, "menu-block");
      ids.push(parentId);
      nextItems = [...items, { kind: "submenu", id: parentId, label: t("inspector.menuNewBlock"), enabled: true, items: [] }];
    }
    const id = nextUniqueId(ids, asList ? "menu-list" : "menu-block");
    const group: MenuItem = { kind: "submenu", id, label: asList ? t("inspector.menuNewList") : t("inspector.menuNewBlock"), enabled: true, items: [child] };
    onEditsChange(putAction(action));
    onChange(appendMenuItem(nextItems, parentId, group));
    setSelectedId(id);
  }

  function applyTemplate(template: MenuTemplate) {
    const result = addTemplate(config, edits, items, template);
    onEditsChange(result.edits);
    onChange(result.items);
    setSelectedId(result.blockId);
    setTemplatesOpen(false);
  }

  /** Change what an action item is: a fresh phrase or keys, or an existing action. */
  function setKind(item: Extract<MenuItem, { kind: "action" }>, kind: ItemKind) {
    const current = actionById.get(item.actionId);
    if (kindOf(current, library) === kind) return;
    let next = edits;
    let actionId: string;
    if (kind === "phrase") {
      const action = withPhrase({ id: newActionId("action-menu-phrase"), displayName: item.label, type: "textSnippet", payload: { source: "inline", text: "", pasteMode: "sendText", tags: [] } }, "", false);
      next = putAction(action);
      actionId = action.id;
    } else if (kind === "keys") {
      const action: Action = { id: newActionId("action-menu-keys"), displayName: item.label, type: "shortcut", payload: { key: "", ctrl: false, shift: false, alt: false, win: false } };
      next = putAction(action);
      actionId = action.id;
    } else {
      const other = otherActions.find((action) => kindOf(action, library) === "other") ?? otherActions[0];
      if (!other) return;
      actionId = other.id;
    }
    onEditsChange(next);
    onChange(updateMenuItem(items, item.id, (currentItem) => (currentItem.kind === "action" ? { ...currentItem, actionId } : currentItem)));
  }

  /** Where else the action runs: "Profile · layer · button" of its bindings. */
  function placesOf(actionId: string): string[] {
    return config.bindings
      .filter((binding) => binding.actionId === actionId && binding.enabled)
      .map((binding) => `${profileName.get(binding.profileId) ?? binding.profileId} · ${t(`layer.${binding.layer}`)} · ${displayNameForControlId(binding.controlId)}`);
  }

  function sendsEnter(item: MenuItem): boolean {
    const action = item.kind === "action" ? actionById.get(item.actionId) : undefined;
    return Boolean(action && phraseOf(action, library)?.enter);
  }

  /** Drag to reorder: the upper half of a row drops before it, the lower half
   *  after it, the middle of a list or block into it. Alt+arrows do the same. */
  function arrangeProps(item: MenuItem) {
    const dropClass = drop?.id === item.id ? ` menu-ed__drop--${drop.place}` : "";
    return {
      draggable: !disabled,
      dropClass,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MENU_DRAG_TYPE, item.id);
        setDragId(item.id);
      },
      onDragEnd: () => { setDragId(null); setDrop(null); },
      onDragOver: (e: React.DragEvent) => {
        if (!dragId || dragId === item.id) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        const place: DropPlace = item.kind === "submenu" && y > 0.25 && y < 0.75 ? "inside" : y < 0.5 ? "before" : "after";
        if (drop?.id !== item.id || drop.place !== place) setDrop({ id: item.id, place });
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dragged = e.dataTransfer.getData(MENU_DRAG_TYPE);
        if (dragged && drop) onChange(placeMenuItem(items, dragged, item.id, drop.place));
        setDragId(null);
        setDrop(null);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (!e.altKey || disabled) return;
        const moves: Record<string, () => MenuItem[]> = {
          ArrowUp: () => moveMenuItem(items, item.id, -1),
          ArrowDown: () => moveMenuItem(items, item.id, 1),
          ArrowLeft: () => outdentMenuItem(items, item.id),
          ArrowRight: () => indentMenuItem(items, item.id),
        };
        if (!moves[e.key]) return;
        e.preventDefault();
        onChange(moves[e.key]!());
      },
    };
  }

  function renderRow(item: MenuItem, nested: boolean) {
    const number = numbers.get(item.id) ?? 0;
    const on = selected?.id === item.id;
    const open = item.kind === "submenu" && (on || (selected && parentOf(items, selected.id) === item.id));
    const { dropClass, ...arrange } = arrangeProps(item);
    return (
      <div key={item.id}>
        <button
          type="button"
          className={`menu-ed__row${nested ? " menu-ed__row--nested" : ""}${on ? " menu-ed__row--on" : ""}${item.enabled ? "" : " menu-ed__row--off"}${dragId === item.id ? " menu-ed__row--dragging" : ""}${dropClass}`}
          aria-pressed={on}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
          onClick={() => setSelectedId(item.id)}
          onContextMenu={(event) => openCtx(event, item)}
          {...arrange}
        >
          <span className={`menu-ed__key${number <= NUMBERED ? "" : " menu-ed__key--extra"}`}>{number}</span>
          <span className="menu-ed__label">{item.label || t("inspector.menuUnnamed")}</span>
          {missing.has(item.id) ? <span className="menu-ed__missing" aria-label={t("inspector.menuIncompleteItem")} /> : null}
          {sendsEnter(item) && !item.label.includes("⏎") ? <span className="menu-ed__mark">⏎</span> : null}
          {item.kind === "action" && item.pinned ? <span className="menu-ed__mark" aria-label={t("inspector.menuPinned")}>★</span> : null}
          {usage && item.kind === "action" ? (
            <span className={`menu-ed__uses${usage[item.actionId] ? "" : " menu-ed__uses--none"}`} title={t("inspector.menuUses")}>
              {usage[item.actionId] ?? 0}×
            </span>
          ) : null}
          {item.kind === "submenu" ? <span className="menu-ed__mark">{open ? "⌄" : "›"}</span> : null}
        </button>
        {/* A list's items show while it or one of them is selected. */}
        {item.kind === "submenu" && open ? item.items.map((inner) => renderRow(inner, true)) : null}
      </div>
    );
  }

  function renderList() {
    if (items.length === 0) return <div className="menu-ed__list menu-ed__list--empty">{t("inspector.menuEmpty")}</div>;
    return (
      <div className="menu-ed__list">
        {items.map((item) => {
          if (item.kind !== "submenu") return renderRow(item, false);
          const { dropClass, ...arrange } = arrangeProps(item);
          return (
            <div key={item.id} className="menu-ed__block">
              <div className="menu-ed__group-line">
                <button type="button" className="menu-ed__fold" aria-expanded={!folded.has(item.id)}
                  aria-label={t(folded.has(item.id) ? "inspector.menuUnfold" : "inspector.menuFold", { name: item.label })}
                  onClick={() => toggleFold(item.id)}>
                  {folded.has(item.id) ? "▸" : "▾"}
                </button>
                <button
                  type="button"
                  className={`menu-ed__group${selected?.id === item.id ? " menu-ed__group--on" : ""}${item.enabled ? "" : " menu-ed__row--off"}${dropClass}`}
                  aria-pressed={selected?.id === item.id}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                  onClick={() => setSelectedId(item.id)}
                  onContextMenu={(event) => openCtx(event, item)}
                  {...arrange}
                >
                  <span className="menu-ed__label">{item.label || t("inspector.menuUnnamed")}</span>
                  <span className="menu-ed__count">{item.items.length}</span>
                </button>
              </div>
              {/* A folded block still shows its selected item. */}
              {item.items.filter((inner) => !folded.has(item.id) || selected?.id === inner.id).map((inner) => renderRow(inner, false))}
            </div>
          );
        })}
      </div>
    );
  }

  function renderTemplates() {
    return (
      <div className="menu-ed__templates">
        {templates.map((template) => (
          <button key={template.id} type="button" className="menu-ed__template" disabled={disabled} onClick={() => applyTemplate(template)}>
            <span className="menu-ed__template-name">{template.name}</span>
            <span className="menu-ed__template-items">{template.items.map((entry) => entry.label).join(" · ")}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderTools(item: MenuItem) {
    const { siblings, index } = placeOf(item);
    // Icon and its word: what each button does reads at a glance.
    const tool = (icon: string, label: string, onClick: (event: React.MouseEvent<HTMLButtonElement>) => void, off = false, extra = "", title = label) => (
      <button type="button" className={`menu-ed__tool${extra}`} disabled={disabled || off} title={title} onClick={onClick}>
        <span className="menu-ed__tool-icon" aria-hidden="true">{icon}</span>
        {label}
      </button>
    );
    return (
      <div className="menu-ed__tools" role="toolbar" aria-label={t("inspector.menuItemTools")}>
        {tool("↑", t("inspector.menuMoveUp"), () => onChange(moveMenuItem(items, item.id, -1)), index <= 0)}
        {tool("↓", t("inspector.menuMoveDown"), () => onChange(moveMenuItem(items, item.id, 1)), index >= siblings.length - 1)}
        <span className="menu-ed__tools-gap" />
        {tool("⧉", t("common.duplicate"), () => duplicate(item))}
        {item.kind === "action"
          ? tool(item.pinned ? "★" : "☆", item.pinned ? t("inspector.menuUnpin") : t("inspector.menuPinShort"), () => togglePin(item), false,
            item.pinned ? " menu-ed__tool--on" : "", item.pinned ? t("inspector.menuUnpin") : t("inspector.menuPin"))
          : null}
        {tool("⋯", t("inspector.menuMoreShort"), (event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setCtx({ x: box.left, y: box.bottom + 4, id: item.id });
        }, false, "", t("inspector.menuMore"))}
        {tool("✕", t("common.delete"), () => remove(item), false, " menu-ed__tool--danger")}
      </div>
    );
  }

  /** Where an item sits: its parent list and its place in it. */
  function placeOf(item: MenuItem) {
    const parentId = parentOf(items, item.id) ?? null;
    const parent = parentId ? findItem(items, parentId) : undefined;
    const siblings = parent?.kind === "submenu" ? parent.items : items;
    return { parentId, siblings, index: siblings.findIndex((sibling) => sibling.id === item.id) };
  }

  function togglePin(item: MenuItem) {
    onChange(updateMenuItem(items, item.id, (current) => {
      if (current.kind !== "action") return current;
      const { pinned: _was, ...rest } = current;
      return current.pinned ? rest : { ...rest, pinned: true };
    }));
  }

  function remove(item: MenuItem, after = removeMenuItem(items, item.id), editsAfter = edits) {
    const { parentId, siblings, index } = placeOf(item);
    setRemoved({ before: items, after, editsBefore: edits, editsAfter, label: item.label });
    onChange(after);
    // Stay where you were: the next item, else the one before, else its list.
    const near = siblings[index + 1] ?? siblings[index - 1];
    setSelectedId(near?.id ?? parentId);
  }

  /** The item itself (same actions, the same phrases) at the end of another menu. */
  function moveToMenu(item: MenuItem, menuId: string) {
    const menu = actions.find((action) => action.id === menuId);
    if (menu?.type !== "menu") return;
    const ids = new Set(collectMenuItemIds(menu.payload.items));
    const fresh = (current: MenuItem): MenuItem => {
      const id = ids.has(current.id) ? nextUniqueId(ids, current.id) : current.id;
      ids.add(id);
      return current.kind === "submenu" ? { ...current, id, items: current.items.map(fresh) } : { ...current, id };
    };
    const target: Action = { ...menu, payload: { ...menu.payload, items: [...menu.payload.items, fresh(item)] } };
    const nextEdits = { ...edits, actions: { ...edits.actions, [menuId]: target } };
    onEditsChange(nextEdits);
    remove(item, undefined, nextEdits);
    setNotice(t("inspector.menuMoved", { name: item.label, menu: menu.displayName }));
  }

  /** Right click on a row, or ⋯: the item's actions, or the menus to copy / move it to. */
  function contextItems(item: MenuItem, to: "copy" | "move" | undefined): ContextMenuProps["items"] {
    if (to) {
      return [
        // What the list below does, as its heading.
        { label: t(to === "copy" ? "inspector.menuCopyTo" : "inspector.menuMoveTo"), disabled: true, onClick: () => {} },
        null,
        ...otherMenus.map((menu) => ({
          label: menu.displayName,
          onClick: () => (to === "copy" ? copyToMenu(item, menu.id) : moveToMenu(item, menu.id)),
        })),
      ];
    }
    const { siblings, index } = placeOf(item);
    const next = (target: "copy" | "move") => () => { keepCtx.current = true; setCtx((open) => (open ? { ...open, to: target } : open)); };
    return [
      { label: `↑ ${t("inspector.menuMoveUp")}`, disabled: index <= 0, onClick: () => onChange(moveMenuItem(items, item.id, -1)) },
      { label: `↓ ${t("inspector.menuMoveDown")}`, disabled: index >= siblings.length - 1, onClick: () => onChange(moveMenuItem(items, item.id, 1)) },
      { label: `⧉ ${t("common.duplicate")}`, onClick: () => duplicate(item) },
      item.kind === "action" ? { label: item.pinned ? `☆ ${t("inspector.menuUnpin")}` : `★ ${t("inspector.menuPin")}`, onClick: () => togglePin(item) } : null,
      null,
      { label: t("inspector.menuCopyTo"), disabled: otherMenus.length === 0, onClick: next("copy") },
      { label: t("inspector.menuMoveTo"), disabled: otherMenus.length === 0, onClick: next("move") },
      null,
      { label: `✕ ${t("common.delete")}`, danger: true, onClick: () => remove(item) },
    ];
  }

  function duplicate(item: MenuItem) {
    const copy = cloneMenuItem(config, edits, item, items);
    onEditsChange(copy.edits);
    onChange(placeMenuItem([...items, copy.item], copy.item.id, item.id, "after"));
    setSelectedId(copy.item.id);
  }

  /** A copy at the end of another menu, saved with this one. */
  function copyToMenu(item: MenuItem, menuId: string) {
    const menu = actions.find((action) => action.id === menuId);
    if (menu?.type !== "menu") return;
    const copy = cloneMenuItem(config, edits, item, menu.payload.items);
    const target: Action = { ...menu, payload: { ...menu.payload, items: [...menu.payload.items, copy.item] } };
    onEditsChange({ ...copy.edits, actions: { ...copy.edits.actions, [menuId]: target } });
    setNotice(t("inspector.menuCopied", { name: item.label, menu: menu.displayName }));
  }

  /** "Add from folder": a list of the folder's prompts, their text copied in. */
  async function addFromFolder() {
    let picked: Awaited<ReturnType<typeof pickTextFolder>>;
    try {
      picked = await pickTextFolder(t("inspector.menuFolderTitle"));
    } catch (error) {
      setNotice(t("inspector.menuFolderFailed", { reason: normalizeCommandError(error).message }));
      return;
    }
    if (!picked) return; // the dialog was cancelled
    // Files left out are named, so a partial import is never mistaken for a whole one.
    const skipped = picked.skipped.length === 0 ? "" : " " + t("inspector.menuFolderSkipped", {
      count: picked.skipped.length,
      list: picked.skipped.map((file) => t("inspector.menuFolderSkippedFile", { name: file.name, reason: t(`inspector.menuFolderReason.${file.reason}`) })).join(", "),
    });
    const prompts = picked.files.flatMap((file) => promptsFromFile(file.name, file.text));
    if (prompts.length === 0) {
      setNotice(t("inspector.menuFolderEmpty", { name: picked.folder }) + skipped);
      return;
    }
    let nextEdits = edits;
    const ids = collectMenuItemIds(items);
    const children: MenuItem[] = prompts.map((prompt) => {
      const { item, action } = newPhrase(config, nextEdits, items, prompt.label);
      const id = nextUniqueId(ids, "menu-item");
      ids.push(id);
      nextEdits = putAction(withPhrase(action, prompt.text, false), nextEdits);
      return { ...item, id };
    });
    let parentId = targetParent();
    let nextItems = items;
    if (parentId === null) {
      parentId = nextUniqueId(ids, "menu-block");
      ids.push(parentId);
      nextItems = [...items, { kind: "submenu", id: parentId, label: t("inspector.menuNewBlock"), enabled: true, items: [] }];
    }
    const listId = nextUniqueId(ids, "menu-list");
    onEditsChange(nextEdits);
    onChange(appendMenuItem(nextItems, parentId, { kind: "submenu", id: listId, label: picked.folder, enabled: true, items: children }));
    setSelectedId(listId);
    setNotice(t("inspector.menuFolderAdded", { count: children.length, name: picked.folder }) + skipped);
  }

  function renderPane(item: MenuItem) {
    const rename = (label: string) => onChange(updateMenuItem(items, item.id, (current) => ({ ...current, label })));
    const parentId = parentOf(items, item.id) ?? null;
    const isBlock = item.kind === "submenu" && parentId === null;
    const nameLabel = isBlock ? t("inspector.menuBlockName") : item.kind === "submenu" ? t("inspector.menuListName") : t("inspector.menuItemLabel");
    // Name, on/off and the tools on one line; what it does under it.
    const head = (
      <div className="menu-ed__pane-head">
        <input className="input menu-ed__pane-name" type="text" value={item.label} disabled={disabled} aria-label={nameLabel}
          placeholder={nameLabel} onChange={(event) => rename(event.target.value)} />
        {item.kind === "submenu" ? <HelpTip text={isBlock ? t("inspector.menuBlockHint") : t("inspector.menuSubmenuHint")} /> : null}
        <label className="menu-ed__switch">
          {t("inspector.menuItemEnabled")}
          <Toggle checked={item.enabled} disabled={disabled} ariaLabel={t("inspector.menuItemEnabled")}
            onChange={(on) => onChange(updateMenuItem(items, item.id, (current) => ({ ...current, enabled: on })))} />
        </label>
      </div>
    );
    if (item.kind === "submenu") {
      return (
        <div className="menu-ed__pane">
          {head}
          {renderTools(item)}
          <p className="menu-ed__note">{t("inspector.menuGroupAddHint", { name: item.label })}</p>
        </div>
      );
    }
    const action = actionById.get(item.actionId);
    const kind = kindOf(action, library);
    const phrase = action ? phraseOf(action, library) : null;
    const places = placesOf(item.actionId);
    const elsewhere = otherMenuUses(config, edits, item.actionId, menuActionId);
    const inBlock = parentId && blocks.some((block) => block.id === parentId) ? parentId : NO_BLOCK;
    const libraryName = phrase?.snippetId ? library.find((snippet) => snippet.id === phrase.snippetId)?.name ?? "" : null;
    return (
      <div className="menu-ed__pane">
        {head}
        {renderTools(item)}
        <div className="menu-ed__pane-row">
          <PillTrack<ItemKind>
            active={kind}
            items={[
              { key: "phrase", label: t("inspector.menuKindPhrase") },
              { key: "keys", label: t("inspector.menuKindKeys") },
              { key: "other", label: t("inspector.menuKindOther") },
            ]}
            onSelect={(next) => setKind(item, next)}
          />
          {kind === "phrase" && action && phrase ? (
            <label className="menu-ed__switch">
              {t("inspector.menuPhraseEnter")}
              <Toggle checked={phrase.enter} disabled={disabled} ariaLabel={t("inspector.menuPhraseEnter")}
                onChange={(enter) => {
                  setPhrase(action, phrase.text, enter);
                  // The name's ⏎ follows the switch.
                  const bare = item.label.replace(/\s*⏎\s*$/, "");
                  const label = enter ? `${bare} ⏎` : bare;
                  if (label !== item.label) onChange(updateMenuItem(items, item.id, (current) => ({ ...current, label })));
                }} />
            </label>
          ) : null}
        </div>
        {kind === "phrase" && action && phrase ? (
          <textarea className="input menu-ed__text" value={phrase.text} disabled={disabled}
            aria-label={t("inspector.menuPhraseText")} placeholder={t("inspector.menuPhrasePlaceholder")}
            onChange={(event) => setPhrase(action, event.target.value, phrase.enter)} />
        ) : null}
        {kind === "keys" && action?.type === "shortcut" ? (
          <ShortcutEditor
            draft={action.payload}
            onChange={(payload) => onEditsChange(putAction({ ...action, payload }))}
            isCapturing={capturing}
            setIsCapturing={setCapturing}
          />
        ) : null}
        {kind === "other" ? (
          <ActionList
            actions={otherActions.filter((other) => kindOf(other, library) === "other")}
            value={item.actionId}
            disabled={disabled}
            onChange={(actionId) => onChange(updateMenuItem(items, item.id, (current) => (current.kind === "action" ? { ...current, actionId } : current)))}
          />
        ) : null}
        {/* Where else it lives, and its block: one line of chips under the content. */}
        <div className="menu-ed__chips">
          {libraryName != null ? (
            <span className="menu-ed__chip menu-ed__chip--accent" title={t("inspector.menuPhraseLibrary", { name: libraryName })}>
              {t("inspector.menuChipLibrary", { name: libraryName })}
            </span>
          ) : null}
          {places.length > 0 ? (
            <span className="menu-ed__chip" title={t("inspector.menuPhraseShared", { places: places.join("; ") })}>
              {t("inspector.menuChipPlaces", { places: places.join("; ") })}
            </span>
          ) : null}
          {elsewhere.length > 0 ? (
            <span className="menu-ed__chip" title={t("inspector.menuAlsoIn", { places: elsewhere.join("; ") })}>
              {t("inspector.menuChipMenus", { places: elsewhere.join("; ") })}
            </span>
          ) : null}
          {blocks.length > 0 && (parentId === null || blocks.some((block) => block.id === parentId)) ? (
            <SelectField
              ariaLabel={t("inspector.menuBlock")}
              className="menu-ed__block-select"
              value={inBlock}
              disabled={disabled}
              options={[{ value: NO_BLOCK, label: t("inspector.menuNoBlock") }, ...blocks.map((block) => ({ value: block.id, label: `${t("inspector.menuBlock")}: ${block.label}` }))]}
              onChange={(blockId) => onChange(moveMenuItemTo(items, item.id, blockId === NO_BLOCK ? null : blockId))}
            />
          ) : null}
        </div>
      </div>
    );
  }

  const target = targetParent();
  const targetName = target ? findItem(items, target)?.label : null;
  return (
    <div className="menu-ed-root">
      {/* The menu's own line: its name, search, filter, add — and the how-to in "?". */}
      <div className="menu-ed__top">
        {onNameChange ? (
          <input className="input menu-ed__menu-name" type="text" value={name ?? ""} placeholder={namePlaceholder}
            aria-label={t("inspector.menuName")} title={t("inspector.menuName")} onChange={(event) => onNameChange(event.target.value)} />
        ) : null}
        <input className="input menu-ed__search" type="search" value={query} placeholder={t("inspector.menuSearchAll")}
          aria-label={t("inspector.menuSearchAll")} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className={`menu-ed__chip-btn${unpickedOnly ? " menu-ed__chip-btn--on" : ""}`} aria-pressed={unpickedOnly}
          onClick={() => setUnpickedOnly(!unpickedOnly)} title={t("inspector.menuUnpickedHint")}>
          {t("inspector.menuUnpicked")}
        </button>
        {sharedUses ? (
          <span className="menu-ed__chip" title={t("picker.menuShared", { count: sharedUses })}>{t("inspector.menuSharedChip", { count: sharedUses })}</span>
        ) : null}
        <button type="button" className="action-button action-button--accent menu-ed__add-btn" disabled={disabled} aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setAddAt({ x: box.right - 200, y: box.bottom + 4 });
          }}>
          + {t("inspector.menuAddButton")} ▾
        </button>
        <HelpTip text={[t("picker.menuLiveHint"), t("inspector.menuDragHint"), targetName ? t("inspector.menuAddsTo", { name: targetName }) : ""].filter(Boolean).join(" ")} />
      </div>
      <div className="menu-ed">
        <div className="menu-ed__side">
          {unpicked ? (
            <div className="menu-ed__list" role="list">
              {unpicked.size === 0 ? <p className="menu-ed__note">{t("inspector.menuUnpickedNone")}</p> : null}
              {[...unpicked].map((id) => (
                <button key={id} type="button" className="menu-ed__row" role="listitem"
                  onClick={() => { setSelectedId(id); setUnpickedOnly(false); }}>
                  <span className="menu-ed__label">{pathTo(items, id).join(" › ")}</span>
                </button>
              ))}
            </div>
          ) : query.trim() ? (
            <div className="menu-ed__list" role="list">
              {hits.length === 0 ? <p className="menu-ed__note">{t("inspector.menuNothingFound")}</p> : null}
              {hits.map((hit) =>
                hit.menuId === (menuActionId ?? "") ? (
                  <button key={`here-${hit.itemId}`} type="button" className="menu-ed__row" role="listitem"
                    onClick={() => { setSelectedId(hit.itemId); setQuery(""); }}>
                    <span className="menu-ed__label">{hit.path.join(" › ")}</span>
                  </button>
                ) : (
                  <div key={`${hit.menuId}-${hit.itemId}`} className="menu-ed__row menu-ed__row--elsewhere" role="listitem">
                    <span className="menu-ed__label">{hit.path.join(" › ")}</span>
                    <span className="menu-ed__mark">{hit.menuName}</span>
                  </div>
                ),
              )}
            </div>
          ) : renderList()}
          {removed && removed.after === items && removed.editsAfter === edits ? (
            <p className="menu-ed__note">
              {t("inspector.menuRemoved", { name: removed.label })}{" "}
              <button type="button" className="menu-ed__link" onClick={() => { onChange(removed.before); onEditsChange(removed.editsBefore); setRemoved(null); setNotice(null); }}>
                {t("inspector.menuRestore")}
              </button>
            </p>
          ) : null}
          {notice ? <p className="menu-ed__note" role="status">{notice}</p> : null}
          {missing.size > 0 ? (
            <p className="menu-ed__note menu-ed__note--warn">
              {t("inspector.menuIncomplete", {
                names: [...missing].map((id) => `«${findItem(items, id)?.label || t("inspector.menuUnnamed")}»`).join(", "),
              })}
            </p>
          ) : null}
        </div>
        {items.length === 0 || templatesOpen ? (
          <div className="menu-ed__pane">
            <div className="menu-ed__pane-head">
              <span className="field__label menu-ed__pane-title">{items.length === 0 ? t("inspector.menuStartWith") : t("inspector.menuAddTemplate")}</span>
              {items.length > 0 ? (
                <button type="button" className="menu-ed__tool" aria-label={t("common.close")} title={t("common.close")} onClick={() => setTemplatesOpen(false)}>✕</button>
              ) : null}
            </div>
            {renderTemplates()}
          </div>
        ) : selected ? (
          renderPane(selected)
        ) : null}
      </div>
      {addAt ? (
        <ContextMenu
          x={addAt.x}
          y={addAt.y}
          onClose={() => setAddAt(null)}
          items={[
            { label: `+ ${t("inspector.menuKindPhrase")}`, onClick: addPhrase },
            { label: `+ ${t("inspector.menuKindKeys")}`, onClick: addKeys },
            null,
            { label: `+ ${t("inspector.menuNewBlock")}`, onClick: () => addGroup(false) },
            { label: `+ ${t("inspector.menuNewList")}`, onClick: () => addGroup(true) },
            null,
            { label: t("inspector.menuTemplates"), onClick: () => setTemplatesOpen(true) },
            { label: `+ ${t("inspector.menuFromFolder")}`, onClick: () => void addFromFolder() },
          ]}
        />
      ) : null}
      {ctxItem && ctx ? (
        <ContextMenu
          key={ctx.to ?? "item"}
          x={ctx.x}
          y={ctx.y}
          items={contextItems(ctxItem, ctx.to)}
          onClose={() => {
            if (keepCtx.current) keepCtx.current = false;
            else setCtx(null);
          }}
        />
      ) : null}
    </div>
  );
}
