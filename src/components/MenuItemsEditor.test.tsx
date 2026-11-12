import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

import type { Action, AppConfig, MenuItem } from "../lib/config";
import { NO_MENU_EDITS, phraseOf } from "../lib/menu-phrase";
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

  it("numbers block items on through the blocks and marks the selected row", () => {
    const blocks: MenuItem[] = [
      { kind: "submenu", id: "b1", label: "Start", enabled: true, items: [{ kind: "action", id: "x1", label: "One", actionId: "a1", enabled: true }] },
      { kind: "submenu", id: "b2", label: "Work", enabled: true, items: [{ kind: "action", id: "x2", label: "Two", actionId: "a1", enabled: true }] },
    ];
    render(<MenuItemsEditor items={blocks} onChange={vi.fn()} config={config} edits={NO_MENU_EDITS} onEditsChange={vi.fn()} />);
    const two = screen.getByRole("button", { name: /2\s*Two/ });
    fireEvent.click(two);
    expect(two.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("adds a new phrase item with its own action, and a block holding one", () => {
    const onChange = vi.fn();
    const onEditsChange = vi.fn();
    render(<MenuItemsEditor items={items} onChange={onChange} config={config} edits={NO_MENU_EDITS} onEditsChange={onEditsChange} />);
    fireEvent.click(screen.getByRole("button", { name: /\+ (Фраза|Phrase)/ }));
    const next: MenuItem[] = onChange.mock.calls[0][0];
    const added = next[1];
    expect(added.kind).toBe("action");
    const actionId = added.kind === "action" ? added.actionId : "";
    expect(onEditsChange.mock.calls[0][0].actions[actionId]).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /\+ (Блок|Block)/ }));
    const withBlock: MenuItem[] = onChange.mock.calls[1][0];
    expect(withBlock[1]).toMatchObject({ kind: "submenu" });
  });
});
