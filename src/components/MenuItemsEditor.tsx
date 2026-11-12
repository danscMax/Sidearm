import { useState } from "react";
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
import { ShortcutEditor } from "./action-picker/ShortcutEditor";
import { PillTrack } from "./PillTrack";
import { HelpTip, SelectField, Toggle } from "./shared";

/** Items a side button picks by number in the popup. */
const NUMBERED = 12;
const NO_BLOCK = "";

export interface MenuItemsEditorProps {
  items: MenuItem[];
  onChange: (items: MenuItem[]) => void;
  config: AppConfig;
  /** Phrase texts and new actions edited here, written on Save. */
  edits: MenuEdits;
  onEditsChange: (edits: MenuEdits) => void;
  /** The menu's own action: never offered as one of its items. */
  menuActionId?: string;
  disabled?: boolean;
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
export function MenuItemsEditor({ items, onChange, config, edits, onEditsChange, menuActionId, disabled }: MenuItemsEditorProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const actions = editedActions(config, edits);
  const library = editedLibrary(config, edits);
  const otherActions = actions.filter((action) => action.id !== menuActionId && action.type !== "disabled");
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

  function renderRow(item: MenuItem, nested: boolean) {
    const number = numbers.get(item.id) ?? 0;
    const on = selected?.id === item.id;
    const open = item.kind === "submenu" && (on || (selected && parentOf(items, selected.id) === item.id));
    return (
      <div key={item.id}>
        <button
          type="button"
          className={`menu-ed__row${nested ? " menu-ed__row--nested" : ""}${on ? " menu-ed__row--on" : ""}${item.enabled ? "" : " menu-ed__row--off"}`}
          aria-pressed={on}
          onClick={() => setSelectedId(item.id)}
        >
          <span className={`menu-ed__key${number <= NUMBERED ? "" : " menu-ed__key--extra"}`}>{number}</span>
          <span className="menu-ed__label">{item.label || t("inspector.menuUnnamed")}</span>
          {missing.has(item.id) ? <span className="menu-ed__missing" aria-label={t("inspector.menuIncompleteItem")} /> : null}
          {sendsEnter(item) && !item.label.includes("⏎") ? <span className="menu-ed__mark">⏎</span> : null}
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
        {items.map((item) =>
          item.kind === "submenu" ? (
            <div key={item.id} className="menu-ed__block">
              <button
                type="button"
                className={`menu-ed__group${selected?.id === item.id ? " menu-ed__group--on" : ""}${item.enabled ? "" : " menu-ed__row--off"}`}
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelectedId(item.id)}
              >
                {item.label || t("inspector.menuUnnamed")}
              </button>
              {item.items.map((inner) => renderRow(inner, false))}
            </div>
          ) : (
            renderRow(item, false)
          ),
        )}
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
    const parentId = parentOf(items, item.id) ?? null;
    const parent = parentId ? findItem(items, parentId) : undefined;
    const siblings = parent?.kind === "submenu" ? parent.items : items;
    const index = siblings.findIndex((sibling) => sibling.id === item.id);
    return (
      <div className="menu-ed__tools">
        <button type="button" className="menu-ed__ghost" disabled={disabled || index <= 0}
          onClick={() => onChange(moveMenuItem(items, item.id, -1))}>↑ {t("inspector.menuMoveUp")}</button>
        <button type="button" className="menu-ed__ghost" disabled={disabled || index >= siblings.length - 1}
          onClick={() => onChange(moveMenuItem(items, item.id, 1))}>↓ {t("inspector.menuMoveDown")}</button>
        <button type="button" className="menu-ed__ghost menu-ed__ghost--danger" disabled={disabled}
          onClick={() => { onChange(removeMenuItem(items, item.id)); setSelectedId(null); }}>✕ {t("common.delete")}</button>
      </div>
    );
  }

  function renderPane(item: MenuItem) {
    const rename = (label: string) => onChange(updateMenuItem(items, item.id, (current) => ({ ...current, label })));
    const parentId = parentOf(items, item.id) ?? null;
    const isBlock = item.kind === "submenu" && parentId === null;
    const nameLabel = isBlock ? t("inspector.menuBlockName") : item.kind === "submenu" ? t("inspector.menuListName") : t("inspector.menuItemLabel");
    const head = (
      <div className="menu-ed__head">
        <label className="field menu-ed__name">
          <span className="field__label">
            {nameLabel}
            {item.kind === "submenu" ? <HelpTip text={isBlock ? t("inspector.menuBlockHint") : t("inspector.menuSubmenuHint")} /> : null}
          </span>
          <input className="input" type="text" value={item.label} disabled={disabled} aria-label={nameLabel}
            onChange={(event) => rename(event.target.value)} />
        </label>
        <div className="menu-ed__enabled">
          <span className="field__label">{t("inspector.menuItemEnabled")}</span>
          <Toggle checked={item.enabled} disabled={disabled} ariaLabel={t("inspector.menuItemEnabled")}
            onChange={(enabled) => onChange(updateMenuItem(items, item.id, (current) => ({ ...current, enabled })))} />
        </div>
      </div>
    );
    if (item.kind === "submenu") {
      return (
        <div className="menu-ed__pane">
          {head}
          <p className="menu-ed__note">{t("inspector.menuGroupAddHint", { name: item.label })}</p>
          {renderTools(item)}
        </div>
      );
    }
    const action = actionById.get(item.actionId);
    const kind = kindOf(action, library);
    const phrase = action ? phraseOf(action, library) : null;
    const places = placesOf(item.actionId);
    const inBlock = parentId && blocks.some((block) => block.id === parentId) ? parentId : NO_BLOCK;
    return (
      <div className="menu-ed__pane">
        {head}
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
          <>
            <label className="field">
              <span className="field__label">{t("inspector.menuPhraseText")}</span>
              <textarea className="input menu-ed__text" rows={6} value={phrase.text} disabled={disabled}
                aria-label={t("inspector.menuPhraseText")} placeholder={t("inspector.menuPhrasePlaceholder")}
                onChange={(event) => setPhrase(action, event.target.value, phrase.enter)} />
            </label>
            <div className="menu-ed__enabled">
              <span className="field__label">{t("inspector.menuPhraseEnter")}</span>
              <Toggle checked={phrase.enter} disabled={disabled} ariaLabel={t("inspector.menuPhraseEnter")}
                onChange={(enter) => setPhrase(action, phrase.text, enter)} />
            </div>
          </>
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
        {blocks.length > 0 && (parentId === null || blocks.some((block) => block.id === parentId)) ? (
          <SelectField
            label={t("inspector.menuBlock")}
            value={inBlock}
            disabled={disabled}
            options={[{ value: NO_BLOCK, label: t("inspector.menuNoBlock") }, ...blocks.map((block) => ({ value: block.id, label: block.label }))]}
            onChange={(blockId) => onChange(moveMenuItemTo(items, item.id, blockId === NO_BLOCK ? null : blockId))}
          />
        ) : null}
        {renderTools(item)}
        {phrase?.snippetId ? (
          <p className="menu-ed__note">{t("inspector.menuPhraseLibrary", { name: library.find((snippet) => snippet.id === phrase.snippetId)?.name ?? "" })}</p>
        ) : null}
        {places.length > 0 ? <p className="menu-ed__note">{t("inspector.menuPhraseShared", { places: places.join("; ") })}</p> : null}
      </div>
    );
  }

  const target = targetParent();
  const targetName = target ? findItem(items, target)?.label : null;
  return (
    <div className="field">
      <span className="field__label">
        {t("inspector.menuHeader")}
        <HelpTip text={t("picker.menuLiveHint")} />
      </span>
      <div className="menu-ed">
        <div className="menu-ed__side">
          {renderList()}
          <div className="menu-ed__bar" role="toolbar" aria-label={t("inspector.menuAdd")}>
            <button type="button" className="menu-ed__ghost" disabled={disabled} onClick={addPhrase}>+ {t("inspector.menuKindPhrase")}</button>
            <button type="button" className="menu-ed__ghost" disabled={disabled} onClick={addKeys}>+ {t("inspector.menuKindKeys")}</button>
            <button type="button" className="menu-ed__ghost" disabled={disabled} onClick={() => addGroup(false)}>+ {t("inspector.menuNewBlock")}</button>
            <button type="button" className="menu-ed__ghost" disabled={disabled} onClick={() => addGroup(true)}>+ {t("inspector.menuNewList")}</button>
            <button type="button" className={`menu-ed__ghost${templatesOpen ? " menu-ed__ghost--on" : ""}`} disabled={disabled}
              aria-expanded={templatesOpen} onClick={() => setTemplatesOpen(!templatesOpen)}>{t("inspector.menuTemplates")}</button>
          </div>
          {targetName ? <p className="menu-ed__note">{t("inspector.menuAddsTo", { name: targetName })}</p> : null}
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
            <span className="field__label">{items.length === 0 ? t("inspector.menuStartWith") : t("inspector.menuAddTemplate")}</span>
            {renderTemplates()}
          </div>
        ) : selected ? (
          renderPane(selected)
        ) : null}
      </div>
    </div>
  );
}
