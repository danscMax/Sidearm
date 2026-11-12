import { describe, expect, it } from "vitest";
import type { Action, AppConfig, MenuItem } from "./config";
import { applyMenuEdits, isMenuIncomplete, moveMenuItem, moveMenuItemTo, newPhrase, NO_MENU_EDITS, parentOf, phraseOf, withPhrase } from "./menu-phrase";

const inline = (id: string, text: string): Action => ({
  id, displayName: id, type: "textSnippet", payload: { source: "inline", text, pasteMode: "clipboardPaste", tags: ["t"] },
});
const library = [{ id: "lib-1", name: "Lib", text: "from library", pasteMode: "sendText" as const, tags: [] }];

function config(actions: Action[]): AppConfig {
  return { actions, snippetLibrary: library, bindings: [], profiles: [] } as unknown as AppConfig;
}

describe("phraseOf", () => {
  it("reads inline, library and text+Enter actions", () => {
    expect(phraseOf(inline("a", "hi"), library)).toEqual({ text: "hi", enter: false });
    expect(phraseOf({ id: "b", displayName: "b", type: "textSnippet", payload: { source: "libraryRef", snippetId: "lib-1" } }, library))
      .toEqual({ text: "from library", enter: false, snippetId: "lib-1" });
    expect(phraseOf(withPhrase(inline("c", ""), "go", true), library)).toEqual({ text: "go", enter: true });
  });

  it("is null for anything else", () => {
    const macro: Action = { id: "m", displayName: "m", type: "sequence", payload: { steps: [{ type: "send", value: "Ctrl+C" }] } };
    expect(phraseOf(macro, library)).toBeNull();
    const twoTexts: Action = { id: "m", displayName: "m", type: "sequence", payload: { steps: [{ type: "text", value: "a" }, { type: "text", value: "b" }] } };
    expect(phraseOf(twoTexts, library)).toBeNull();
  });
});

describe("withPhrase", () => {
  it("toggles between a text snippet and text + Enter, keeping id, name and paste mode", () => {
    const sent = withPhrase(inline("a", "hi"), "hi", true);
    expect(sent.type).toBe("sequence");
    expect(sent.id).toBe("a");
    const back = withPhrase(inline("a", "hi"), "bye", false);
    expect(back).toMatchObject({ id: "a", type: "textSnippet", payload: { source: "inline", text: "bye", pasteMode: "clipboardPaste", tags: ["t"] } });
  });
});

describe("applyMenuEdits", () => {
  it("writes edited actions and library text, and drops a new phrase the menu no longer uses", () => {
    const base = config([inline("a", "old")]);
    const edits = {
      actions: { a: inline("a", "new"), orphan: inline("orphan", "x"), fresh: inline("fresh", "y") },
      library: { "lib-1": "changed" },
    };
    const items: MenuItem[] = [{ kind: "action", id: "i1", label: "F", actionId: "fresh", enabled: true }];
    const next = applyMenuEdits(base, edits, items);
    expect(next.actions.map((action) => action.id)).toEqual(["a", "fresh"]);
    expect(phraseOf(next.actions[0], next.snippetLibrary)?.text).toBe("new");
    expect(next.snippetLibrary[0].text).toBe("changed");
  });
});

describe("newPhrase / isMenuIncomplete", () => {
  it("creates a fresh phrase with unique ids, which blocks Save until it has text", () => {
    const base = config([inline("action-menu-phrase", "taken")]);
    const { item, action } = newPhrase(base, NO_MENU_EDITS, [], "New");
    expect(action.id).not.toBe("action-menu-phrase");
    expect(item).toMatchObject({ kind: "action", actionId: action.id, label: "New" });
    const edits = { actions: { [action.id]: action }, library: {} };
    expect(isMenuIncomplete(base, edits, [item])).toBe(true);
    const typed = { actions: { [action.id]: withPhrase(action, "text", false) }, library: {} };
    expect(isMenuIncomplete(base, typed, [item])).toBe(false);
  });
});

describe("moveMenuItem", () => {
  const items: MenuItem[] = [
    { kind: "action", id: "a", label: "A", actionId: "x", enabled: true },
    { kind: "submenu", id: "s", label: "S", enabled: true, items: [
      { kind: "action", id: "c", label: "C", actionId: "x", enabled: true },
      { kind: "action", id: "d", label: "D", actionId: "x", enabled: true },
    ] },
  ];
  it("swaps with a neighbour, inside submenus too, and stops at the ends", () => {
    expect(moveMenuItem(items, "a", 1).map((item) => item.id)).toEqual(["s", "a"]);
    expect(moveMenuItem(items, "a", -1)).toBe(items);
    const nested = moveMenuItem(items, "d", -1)[1];
    expect(nested.kind === "submenu" && nested.items.map((item) => item.id)).toEqual(["d", "c"]);
  });
});

describe("moveMenuItemTo / parentOf", () => {
  const items: MenuItem[] = [
    { kind: "action", id: "a", label: "A", actionId: "x", enabled: true },
    { kind: "submenu", id: "b1", label: "Block", enabled: true, items: [{ kind: "action", id: "c", label: "C", actionId: "x", enabled: true }] },
  ];
  it("moves an item into a block and back out; a block left empty goes away", () => {
    const inBlock = moveMenuItemTo(items, "a", "b1");
    expect(parentOf(inBlock, "a")).toBe("b1");
    expect(inBlock.map((item) => item.id)).toEqual(["b1"]);
    const out = moveMenuItemTo(inBlock, "c", null);
    expect(parentOf(out, "c")).toBeNull();
    expect(moveMenuItemTo(items, "b1", "b1")).toBe(items);
  });
  it("an unnamed item makes the menu incomplete", () => {
    const base = { actions: [], snippetLibrary: [], bindings: [], profiles: [] } as unknown as AppConfig;
    expect(isMenuIncomplete(base, NO_MENU_EDITS, [{ kind: "action", id: "a", label: " ", actionId: "x", enabled: true }])).toBe(true);
  });
});
