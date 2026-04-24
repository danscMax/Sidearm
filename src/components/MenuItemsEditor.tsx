import { useTranslation } from "react-i18next";
import type { Action, MenuItem } from "../lib/config";
import {
  createDefaultActionMenuItem,
  createDefaultSubmenuItem,
} from "../lib/config-editing";
import {
  appendMenuItem,
  collectMenuItemIds,
  removeMenuItem,
  updateMenuItem,
} from "../lib/menu-helpers";

export interface MenuItemsEditorProps {
  items: MenuItem[];
  onChange: (items: MenuItem[]) => void;
  availableActions: Action[];
  disabled?: boolean;
}

/**
 * Reusable editor for `menu`-action items. Handles both flat action items
 * and recursively-nested submenus. Parent owns the `items` array and
 * receives a full replacement through `onChange` on every mutation.
 */
export function MenuItemsEditor({
  items,
  onChange,
  availableActions,
  disabled,
}: MenuItemsEditorProps) {
  const { t } = useTranslation();
  const noActionsAvailable = availableActions.length === 0;

  function addMenuActionItem(parentId: string | null) {
    const fallbackAction = availableActions[0];
    if (!fallbackAction) return;
    const existingIds = collectMenuItemIds(items);
    const nextItem = createDefaultActionMenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );
    onChange(appendMenuItem(items, parentId, nextItem));
  }

  function addSubmenuItem(parentId: string | null) {
    const fallbackAction = availableActions[0];
    if (!fallbackAction) return;
    const existingIds = collectMenuItemIds(items);
    const nextItem = createDefaultSubmenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );
    onChange(appendMenuItem(items, parentId, nextItem));
  }

  function renderMenuItemEditor(
    item: MenuItem,
    depth: number,
    canRemove: boolean,
  ) {
    return (
      <div
        className="compound-card compound-card--menu"
        key={item.id}
        style={{ marginLeft: `${depth * 18}px` }}
      >
        <div className="compound-card__header">
          <div>
            <strong>{item.label}</strong>
            <span className="compound-card__meta">
              {item.kind === "action"
                ? t("inspector.menuItemAction")
                : t("inspector.menuItemSubmenu")}
            </span>
          </div>
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            disabled={disabled || !canRemove}
            onClick={() => onChange(removeMenuItem(items, item.id))}
          >
            {t("common.delete")}
          </button>
        </div>

        <div className="editor-grid">
          <div className="field">
            <span className="field__label">{t("inspector.menuItemId")}</span>
            <code className="field__static">{item.id}</code>
          </div>

          <label className="field">
            <span className="field__label">{t("inspector.menuItemLabel")}</span>
            <input
              type="text"
              value={item.label}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    label: event.target.value,
                  })),
                )
              }
            />
          </label>

          <label className="field field--inline">
            <span className="field__label">{t("inspector.menuItemEnabled")}</span>
            <input
              type="checkbox"
              checked={item.enabled}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    enabled: event.target.checked,
                  })),
                )
              }
            />
          </label>

          {item.kind === "action" ? (
            <label className="field">
              <span className="field__label">{t("inspector.menuItemActionRef")}</span>
              <select
                value={item.actionRef}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    updateMenuItem(items, item.id, (currentItem) =>
                      currentItem.kind === "action"
                        ? { ...currentItem, actionRef: event.target.value }
                        : currentItem,
                    ),
                  )
                }
              >
                {availableActions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.pretty} ({action.type})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <div className="field__header">
                <span className="field__label">{t("inspector.menuItemNested")}</span>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => addMenuActionItem(item.id)}
                    disabled={disabled || noActionsAvailable}
                  >
                    {t("inspector.addActionItem")}
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => addSubmenuItem(item.id)}
                    disabled={disabled || noActionsAvailable}
                  >
                    {t("inspector.addSubmenu")}
                  </button>
                </div>
              </div>

              <div className="stack-list">
                {item.items.map((childItem) =>
                  renderMenuItemEditor(
                    childItem,
                    depth + 1,
                    item.items.length > 1,
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <div className="field__header">
        <span className="field__label">{t("inspector.menuHeader")}</span>
        <div className="editor-actions">
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            onClick={() => addMenuActionItem(null)}
            disabled={disabled || noActionsAvailable}
          >
            {t("inspector.addActionItem")}
          </button>
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            onClick={() => addSubmenuItem(null)}
            disabled={disabled || noActionsAvailable}
          >
            {t("inspector.addSubmenu")}
          </button>
        </div>
      </div>

      {noActionsAvailable ? (
        <div className="notice notice--warning">
          <strong>{t("inspector.noActions")}</strong>
          <p>{t("inspector.noActionsBody")}</p>
        </div>
      ) : null}

      <div className="stack-list">
        {items.map((item) => renderMenuItemEditor(item, 0, items.length > 1))}
      </div>
    </div>
  );
}
