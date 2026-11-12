import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { extractProfileExport, importProfile } from "./config-editing";
import { makeConfig } from "./test-fixtures";

const phrase: Action = { id: "a-hi", type: "textSnippet", displayName: "Hi", payload: { source: "inline", text: "hello", pasteMode: "sendText", tags: [] } };
const keys: Action = { id: "a-key", type: "shortcut", displayName: "Del", payload: { key: "Delete", ctrl: false, shift: false, alt: false, win: false } };
const menu = {
  id: "a-menu", type: "menu", displayName: "Phrases",
  payload: { items: [{ kind: "submenu", id: "blk", label: "B", enabled: true, items: [{ kind: "action", id: "i1", label: "Hi", actionId: "a-hi", enabled: true }] }] },
} as Action;
const bind = (id: string, controlId: string, actionId: string): Binding =>
  ({ id, profileId: "p1", layer: "standard", controlId, label: id, actionId, enabled: true });

describe("profile export with menus", () => {
  const config = makeConfig({ actions: [phrase, keys, menu], bindings: [bind("b1", "thumb_01", "a-menu"), bind("b2", "mouse_4", "a-key")] });

  it("carries a menu's item actions and re-points them on import", () => {
    const data = extractProfileExport(config, "p1");
    expect(data.actions.map((a) => a.id).sort()).toEqual(["a-hi", "a-key", "a-menu"]);
    const imported = importProfile(makeConfig(), data);
    const importedMenu = imported.actions.find((a) => a.type === "menu");
    const item = importedMenu?.type === "menu" ? importedMenu.payload.items[0] : undefined;
    const inner = item?.kind === "submenu" ? item.items[0] : undefined;
    expect(inner?.kind === "action" && imported.actions.some((a) => a.id === inner.actionId && a.type === "textSnippet")).toBe(true);
  });

  it("leaves texts and menus out when asked", () => {
    const data = extractProfileExport(config, "p1", { withoutTexts: true });
    expect(data.bindings.map((b) => b.id)).toEqual(["b2"]);
    expect(data.actions.map((a) => a.id)).toEqual(["a-key"]);
  });
});
