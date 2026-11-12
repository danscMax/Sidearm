import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { AppConfig } from "./config";
import { NO_MENU_EDITS, phraseOf } from "./menu-phrase";
import { addTemplate, menuTemplates } from "./menu-templates";

const t = ((key: string) => key) as unknown as TFunction;
const config = { actions: [], snippetLibrary: [{ id: "lib-1", name: "Lib", text: "x", pasteMode: "sendText", tags: [] }], bindings: [], profiles: [] } as unknown as AppConfig;

describe("menu templates", () => {
  it("offers the library as a template only when it has snippets", () => {
    expect(menuTemplates(t, config).map((template) => template.id)).toContain("library");
    expect(menuTemplates(t, { ...config, snippetLibrary: [] }).map((template) => template.id)).not.toContain("library");
  });

  it("adds a template as a block with its own phrase, keys and library actions", () => {
    const [agent, editing] = menuTemplates(t, config);
    const first = addTemplate(config, NO_MENU_EDITS, [], agent);
    const block = first.items[0];
    expect(block.kind).toBe("submenu");
    const actions = Object.values(first.edits.actions);
    expect(actions.some((action) => phraseOf(action, [])?.enter)).toBe(true); // "continue" sends Enter
    const second = addTemplate(config, first.edits, first.items, editing);
    const copy = Object.values(second.edits.actions).find((action) => action.type === "shortcut");
    expect(copy?.type === "shortcut" && copy.payload).toMatchObject({ key: "C", ctrl: true, shift: false });
    const ids = Object.keys(second.edits.actions);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.items.length).toBe(2);
  });
});
