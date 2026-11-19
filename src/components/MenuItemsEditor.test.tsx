import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import i18n from "../i18n";

import type { Action, AppConfig, MenuItem } from "../lib/config";
import { applyMenuEdits, NO_MENU_EDITS, phraseOf } from "../lib/menu-phrase";
import { MenuItemsEditor } from "./MenuItemsEditor";

afterEach(() => cleanup());

const phrase: Action = { id: "a1", displayName: "Hi", type: "textSnippet", payload: { source: "inline", text: "hello", pasteMode: "sendText", tags: [] } };
const config = { actions: [phrase], snippetLibrary: [], bindings: [], profiles: [] } as unknown as AppConfig;
const items: MenuItem[] = [{ kind: "action", id: "i1", label: "Hi", actionId: "a1", enabled: true }];

describe("MenuItemsEditor", () => {
  it("opens on the first item and edits its phrase text in the pane", () => {
    const onEditsChange = vi.fn();
    render(<MenuItemsEditor items={items} onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={onEditsChange} />);
    expect(screen.queryByText("i1")).toBeNull(); // no internal ids
    expect((screen.getByRole("textbox", { name: /напечатает|types/i }) as HTMLTextAreaElement).value).toBe("hello");
    fireEvent.change(screen.getByRole("textbox", { name: /напечатает|types/i }), { target: { value: "bye" } });
    const edited: Action = onEditsChange.mock.calls[0][0].actions.a1;
    expect(phraseOf(edited, [])).toEqual({ text: "bye", enter: false });
  });

  it("gives the phrase the token chips, the preview and the typo warning", () => {
    const onEditsChange = vi.fn();
    const typo: Action = { ...phrase, payload: { source: "inline", text: "hi {clipbord}", pasteMode: "sendText", tags: [] } };
    render(<MenuItemsEditor items={items} onChange={vi.fn()} config={{ ...config, actions: [typo] }} edits={NO_MENU_EDITS} onEditsChange={onEditsChange} />);
    expect(screen.getByText(i18n.t("picker.tokenUnknownLike", { token: "{clipbord}", fix: "{clipboard}" }))).toBeTruthy();
    expect(screen.getByText(i18n.t("picker.tokenPreviewLabel"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.tokenFix", { fix: "{clipboard}" }) }));
    expect(phraseOf(onEditsChange.mock.calls[0][0].actions.a1, [])).toEqual({ text: "hi {clipboard}", enter: false });
  });

  it("an item opening another menu leads into it: its edits go to that menu, Back returns", () => {
    const max: Action = { id: "m2", displayName: "Max", type: "menu", payload: { items: [{ kind: "action", id: "x1", label: "Hi", actionId: "a1", enabled: true }] } };
    const cfg = { ...config, actions: [phrase, max] } as AppConfig;
    function Host() {
      const [edits, setEdits] = useState(NO_MENU_EDITS);
      return <MenuItemsEditor items={[{ kind: "action", id: "i1", label: "Max", actionId: "m2", enabled: true }]} onChange={vi.fn()}
        config={cfg} edits={edits} onEditsChange={(next) => { setEdits(next); onEdits(next); }} name="Root" onNameChange={vi.fn()} />;
    }
    const onEdits = vi.fn();
    render(<Host />);
    expect(screen.getByText(i18n.t("inspector.menuLinkedInfo", { name: "Max", count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("inspector.menuLinkedEdit", { name: "Max" }) }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("inspector.menuName") }), { target: { value: "Max 2" } });
    expect(onEdits.mock.lastCall?.[0].actions.m2.displayName).toBe("Max 2");
    expect(screen.getByRole("button", { name: /1\s*Hi/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("inspector.menuLinkedBack", { name: "Root" }) }));
    expect((screen.getByRole("textbox", { name: i18n.t("inspector.menuName") }) as HTMLInputElement).value).toBe("Root");
  });

  it("numbers block items on through the blocks and marks the selected row", () => {
    const blocks: MenuItem[] = [
      { kind: "submenu", id: "b1", label: "Start", enabled: true, items: [{ kind: "action", id: "x1", label: "One", actionId: "a1", enabled: true }] },
      { kind: "submenu", id: "b2", label: "Work", enabled: true, items: [{ kind: "action", id: "x2", label: "Two", actionId: "a1", enabled: true }] },
    ];
    render(<MenuItemsEditor items={blocks} onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    const two = screen.getByRole("button", { name: /2\s*Two/ });
    fireEvent.click(two);
    expect(two.getAttribute("aria-pressed")).toBe("true");
    // A block's line: its name and how many items it holds.
    expect(screen.getByRole("button", { name: /^Start\s*1$/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("adds a separator after the selected item; it takes no number, the next item does", () => {
    const two: MenuItem[] = ["One", "Two"].map((label, i) => ({ kind: "action", id: `i${i}`, label, actionId: "a1", enabled: true }));
    function Host() {
      const [list, setList] = useState(two);
      return <MenuItemsEditor items={list} onChange={setList} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />;
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: /1\s*One/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add|Добавить/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Separator|Разделитель/ }));
    const rows = Array.from(container.querySelectorAll(".menu-ed__row")).map((row) => row.getAttribute("aria-label") ?? row.textContent ?? "");
    expect(rows[0]).toMatch(/^1One/);
    expect(rows[1]).toMatch(/Separator|Разделитель/);
    expect(rows[2]).toMatch(/^2Two/);
    expect(screen.getByRole("button", { name: /Separator|Разделитель/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /2\s*Two/ })).toBeTruthy();
  });

  it("a second click on an open list, or its chevron, folds it; the chevron opens it again", () => {
    const blocks: MenuItem[] = [
      { kind: "submenu", id: "b1", label: "Start", enabled: true, items: [
        { kind: "submenu", id: "l1", label: "List", enabled: true, items: [{ kind: "action", id: "x1", label: "Inner", actionId: "a1", enabled: true }] },
      ] },
    ];
    render(<MenuItemsEditor items={blocks} onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} initialSelectedId="l1" />);
    expect(screen.getByRole("button", { name: /1\s*Inner/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^1\s*List/ }));
    expect(screen.queryByRole("button", { name: /1\s*Inner/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Unfold|Развернуть/ }));
    expect(screen.getByRole("button", { name: /1\s*Inner/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fold «List»|Свернуть «List»/ }));
    expect(screen.queryByRole("button", { name: /1\s*Inner/ })).toBeNull();
  });

  it("folding a block hides all it holds and moves a selection inside onto the block", () => {
    const blocks: MenuItem[] = [
      { kind: "submenu", id: "b1", label: "Start", enabled: true, items: [{ kind: "action", id: "x1", label: "One", actionId: "a1", enabled: true }] },
    ];
    render(<MenuItemsEditor items={blocks} onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} initialSelectedId="x1" />);
    fireEvent.click(screen.getByRole("button", { name: /Fold|Свернуть/ }));
    expect(screen.queryByRole("button", { name: /1\s*One/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Start\s*1$/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("picks several items with Ctrl / Shift and turns them off or deletes them with one Restore", () => {
    const three: MenuItem[] = ["One", "Two", "Three"].map((label, i) => ({ kind: "action", id: `i${i}`, label, actionId: "a1", enabled: true }));
    function Host() {
      const [list, setList] = useState(three);
      return <MenuItemsEditor items={list} onChange={setList} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: /1\s*One/ }));
    fireEvent.click(screen.getByRole("button", { name: /3\s*Three/ }), { shiftKey: true });
    expect(screen.getByText(/3 items picked|Выбрано 3 пункта/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /2\s*Two/ }), { ctrlKey: true });
    expect(screen.getByText(/2 items picked|Выбрано 2 пункта/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^(Turn off|Выключить)$/ }));
    expect(screen.getByRole("button", { name: /1\s*One/ }).className).toContain("menu-ed__row--off");
    expect(screen.getByRole("button", { name: /2\s*Two/ }).className).not.toContain("menu-ed__row--off");
    fireEvent.click(screen.getByRole("button", { name: /^(Delete|Удалить)$/ }));
    expect(screen.queryByRole("button", { name: /One/ })).toBeNull();
    expect(screen.getByText(/2 items deleted|Удалено 2 пункта/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Restore|Вернуть/ }));
    expect(screen.getByRole("button", { name: /1\s*One/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /3\s*Three/ })).toBeTruthy();
  });

  it("Ctrl+click inside the selected list picks those items, not the list", () => {
    const nested: MenuItem[] = [{ kind: "submenu", id: "list", label: "List", enabled: true, items: [
      { kind: "action", id: "one", label: "One", actionId: "a1", enabled: true },
      { kind: "action", id: "two", label: "Two", actionId: "a1", enabled: true },
    ] }];
    render(<MenuItemsEditor items={nested} initialSelectedId="list" onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /One/ }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Two/ }), { ctrlKey: true });
    expect(screen.getByText(/2 items picked|Выбрано 2 пункта/)).toBeTruthy();
  });

  it("after deleting an item of a list, the next item of that list is selected", () => {
    const onChange = vi.fn();
    const nested: MenuItem[] = [{ kind: "submenu", id: "b", label: "Block", enabled: true, items: [
      { kind: "submenu", id: "l", label: "List", enabled: true, items: [
        { kind: "action", id: "one", label: "One", actionId: "a1", enabled: true },
        { kind: "action", id: "two", label: "Two", actionId: "a1", enabled: true },
      ] },
    ] }];
    const { rerender } = render(<MenuItemsEditor items={nested} initialSelectedId="one" onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Удалить|Delete/ }));
    rerender(<MenuItemsEditor items={onChange.mock.calls[0][0]} initialSelectedId="one" onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Two/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("right click on a row moves the item, with its own action, to another menu", () => {
    const other: Action = { id: "m2", displayName: "Commands", type: "menu", payload: { items: [] } };
    const withMenu = { ...config, actions: [phrase, other] } as AppConfig;
    const onChange = vi.fn();
    const onEditsChange = vi.fn();
    render(<MenuItemsEditor items={items} menuActionId="m1" onChange={onChange} config={withMenu} edits={NO_MENU_EDITS} onEditsChange={onEditsChange} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /1\s*Hi/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Переместить в меню|Move to menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Commands" }));
    expect(onEditsChange.mock.calls.at(-1)![0].actions.m2.payload.items).toEqual(items);
    expect(onChange.mock.calls.at(-1)![0]).toEqual([]);
  });

  function movedMenu(onSave = vi.fn()) {
    const source: Extract<Action, { type: "menu" }> = { id: "m1", displayName: "Source", type: "menu", payload: { items } };
    const target: Extract<Action, { type: "menu" }> = { id: "m2", displayName: "Commands", type: "menu", payload: { items: [] } };
    const withMenus = { ...config, actions: [phrase, source, target] } as AppConfig;
    function Harness() {
      const [draft, setDraft] = useState(items);
      const [edits, setEdits] = useState(NO_MENU_EDITS);
      return <>
        <MenuItemsEditor items={draft} menuActionId="m1" onChange={setDraft} config={withMenus} edits={edits} onEditsChange={setEdits} />
        <button onClick={() => onSave(applyMenuEdits({ ...withMenus, actions: [phrase, { ...source, payload: { items: draft } }, target] }, edits, draft))}>Save draft</button>
        <button onClick={() => setEdits({ ...edits, actions: { ...edits.actions, a1: { ...phrase, displayName: "Edited after move" } } })}>Subsequent edit</button>
      </>;
    }
    render(<Harness />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /1\s*Hi/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Переместить в меню|Move to menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Commands" }));
    return onSave;
  }

  it("restores both menus after a move, including the saved draft", () => {
    const onSave = movedMenu();
    fireEvent.click(screen.getByRole("button", { name: /Вернуть|Restore/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const saved = onSave.mock.calls[0][0] as AppConfig;
    expect(saved.actions.find((action) => action.id === "m1")).toMatchObject({ payload: { items } });
    expect(saved.actions.find((action) => action.id === "m2")).toMatchObject({ payload: { items: [] } });
  });

  it("does not offer a move restore after later action edits", () => {
    movedMenu();
    expect(screen.getByRole("button", { name: /Вернуть|Restore/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Subsequent edit" }));
    expect(screen.queryByRole("button", { name: /Вернуть|Restore/ })).toBeNull();
  });

  it("pins an item to the top of the popup and unpins it", () => {
    const onChange = vi.fn();
    render(<MenuItemsEditor items={items} onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Закрепить|Pin/ }));
    const pinned: MenuItem[] = onChange.mock.calls[0][0];
    expect(pinned[0]).toMatchObject({ id: "i1", pinned: true });
    cleanup();
    render(<MenuItemsEditor items={pinned} onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Открепить|Unpin/ }));
    expect(onChange.mock.calls[1][0][0]).not.toHaveProperty("pinned");
  });

  it("adds a new phrase item with its own action, and a block holding one", () => {
    const onChange = vi.fn();
    const onEditsChange = vi.fn();
    render(<MenuItemsEditor items={items} onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={onEditsChange} />);
    const add = (name: RegExp) => {
      fireEvent.click(screen.getByRole("button", { name: /\+ (Добавить|Add)/ }));
      fireEvent.click(screen.getByRole("menuitem", { name }));
    };
    add(/\+ (Фраза|Phrase)/);
    const next: MenuItem[] = onChange.mock.calls[0][0];
    const added = next[1];
    expect(added.kind).toBe("action");
    const actionId = added.kind === "action" ? added.actionId : "";
    expect(onEditsChange.mock.calls[0][0].actions[actionId]).toBeTruthy();
    add(/\+ (Блок|Block)/);
    const withBlock: MenuItem[] = onChange.mock.calls[1][0];
    expect(withBlock[1]).toMatchObject({ kind: "submenu" });
  });
});
