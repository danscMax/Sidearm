import { describe, expect, it } from "vitest";
import type { Action, Binding, MenuItem } from "./config";
import { bindingUses, cloneMenuItem, indentMenuItem, otherMenuUses, outdentMenuItem, placeMenuItem, promptsFromFile, searchMenus } from "./menu-arrange";
import { NO_MENU_EDITS } from "./menu-phrase";
import { makeConfig } from "./test-fixtures";

const act = (id: string, actionId = `a-${id}`): MenuItem => ({ kind: "action", id, label: id, actionId, enabled: true });
const sub = (id: string, items: MenuItem[]): MenuItem => ({ kind: "submenu", id, label: id, enabled: true, items });
const shape = (items: MenuItem[]): unknown => items.map((item) => (item.kind === "submenu" ? { [item.id]: shape(item.items) } : item.id));

const tree = (): MenuItem[] => [sub("B", [act("x"), sub("L", [act("y")])]), act("z")];

describe("placeMenuItem", () => {
  it("drops before, after and inside", () => {
    expect(shape(placeMenuItem(tree(), "z", "x", "before"))).toEqual([{ B: ["z", "x", { L: ["y"] }] }]);
    expect(shape(placeMenuItem(tree(), "x", "B", "after"))).toEqual([{ B: [{ L: ["y"] }] }, "x", "z"]);
    expect(shape(placeMenuItem(tree(), "z", "L", "inside"))).toEqual([{ B: ["x", { L: ["y", "z"] }] }]);
  });

  it("refuses a drop into itself, its descendants or a non-list; an emptied list goes away", () => {
    expect(placeMenuItem(tree(), "B", "y", "before")).toEqual(tree());
    expect(placeMenuItem(tree(), "z", "x", "inside")).toEqual(tree());
    expect(shape(placeMenuItem(tree(), "y", "z", "after"))).toEqual([{ B: ["x"] }, "z", "y"]);
  });

  it("moves a level in and out", () => {
    expect(shape(outdentMenuItem(tree(), "y"))).toEqual([{ B: ["x", "y"] }, "z"]);
    expect(shape(indentMenuItem(tree(), "z"))).toEqual([{ B: ["x", { L: ["y"] }, "z"] }]);
    expect(indentMenuItem(tree(), "x")).toEqual(tree());
  });
});

describe("cloneMenuItem", () => {
  it("copies a list with fresh ids and a fresh action per phrase", () => {
    const phrase: Action = { id: "a-y", type: "textSnippet", displayName: "y", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } };
    const config = makeConfig({ actions: [phrase] });
    const items = tree();
    const { item, edits } = cloneMenuItem(config, NO_MENU_EDITS, items[0]!.kind === "submenu" ? items[0]!.items[1]! : items[0]!, items);
    expect(item.id).not.toBe("L");
    const inner = item.kind === "submenu" ? item.items[0]! : item;
    expect(inner.kind === "action" && inner.actionId).not.toBe("a-y");
    expect(Object.values(edits.actions).map((action) => action.payload)).toEqual([phrase.payload]);
  });
});

describe("promptsFromFile", () => {
  const long = "x".repeat(250);
  it("takes the fenced prompts of a how-to page, else the whole text", () => {
    expect(promptsFromFile("f", `# Title\nintro\n\`\`\`text\n${long}\n\`\`\`\n\`\`\`\nshort\n\`\`\``)).toEqual([{ label: "Title", text: long }]);
    expect(promptsFromFile("f", `\`\`\`\n${long}\n\`\`\`\n\`\`\`\n${long}y\n\`\`\``).map((p) => p.label)).toEqual(["f · 1", "f · 2"]);
    expect(promptsFromFile("plain", " just text ")).toEqual([{ label: "plain", text: "just text" }]);
    expect(promptsFromFile("empty", "  ")).toEqual([]);
  });
});

describe("searching all menus", () => {
  const phrase = (id: string, text: string): Action => ({ id, type: "textSnippet", displayName: id, payload: { source: "inline", text, pasteMode: "sendText", tags: [] } });
  const config = makeConfig({
    actions: [
      phrase("a-hello", "Добрый день"),
      { id: "m2", type: "menu", displayName: "Другое", payload: { items: [sub("Письма", [act("Привет", "a-hello")])] } } as Action,
    ],
  });

  it("finds by name and by sent text, with the path", () => {
    const hits = searchMenus(config, NO_MENU_EDITS, "добрый", { menuId: "m1", items: [act("Тут", "a-hello")] });
    expect(hits.map((hit) => [hit.menuName, ...hit.path].filter(Boolean).join(" › "))).toEqual(["Тут", "Другое › Письма › Привет"]);
  });

  it("lists the other menus using the same action", () => {
    expect(otherMenuUses(config, NO_MENU_EDITS, "a-hello", "m1")).toEqual(["Другое › Письма › Привет"]);
  });
});

describe("bindingUses", () => {
  it("lists the other buttons of the action once, never the edited one or its twin on the other mouse", () => {
    const bind = (id: string, controlId: string, extra: Partial<Binding> = {}): Binding =>
      ({ id, profileId: "p1", layer: "standard", controlId, label: id, actionId: "a1", enabled: true, ...extra });
    const own = bind("own", "thumb_01");
    const config = makeConfig({ bindings: [own, bind("twin", "v3_thumb_01"), bind("hold", "mouse_4", { triggerMode: "longPress" }), bind("off", "mouse_4", { enabled: false, layer: "hypershift" })] });
    const uses = bindingUses(config, "a1", own);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/·.*·/);
  });
});
