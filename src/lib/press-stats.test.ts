import { describe, expect, it } from "vitest";
import type { Action, Binding, MenuItem } from "./config";
import { holdHints, type PressLog, keystrokesOf, layerHeat, localDate, savedKeystrokes, slotKey, sumDays, topPlaces, unpickedItems, unusedPlaces } from "./press-stats";
import { makeConfig } from "./test-fixtures";

const key = (id: string, k: string, ctrl = false): Action =>
  ({ id, type: "shortcut", displayName: k, payload: { key: k, ctrl, shift: false, alt: false, win: false } }) as Action;
const text = (id: string, value: string): Action =>
  ({ id, type: "textSnippet", displayName: id, payload: { source: "inline", text: value, pasteMode: "sendText", tags: [] } }) as Action;
const bind = (id: string, controlId: string, actionId: string, extra: Partial<Binding> = {}): Binding =>
  ({ id, profileId: "p1", layer: "standard", controlId, label: id, actionId, enabled: true, ...extra });

const today = new Date(2026, 10, 13);
const day = (offset: number) => { const d = new Date(today); d.setDate(d.getDate() - offset); return localDate(d); };

describe("press statistics", () => {
  const config = makeConfig({
    actions: [key("c", "C", true), text("hi", "hello"), key("v", "V", true)],
    bindings: [bind("copy", "thumb_01", "c"), bind("hello", "mouse_4", "hi"), bind("hsv", "thumb_01", "v", { layer: "hypershift" })],
  });
  const device = config.physicalControls[0]!.deviceId;
  const log: PressLog = {
    [day(0)]: { slots: { [slotKey(config.bindings[0]!)]: 5, [slotKey(config.bindings[2]!)]: 25 }, actions: { c: 5, v: 25 } },
    [day(8)]: { slots: { [slotKey(config.bindings[0]!)]: 2, [slotKey(config.bindings[1]!)]: 3 }, actions: { hi: 3 } },
  };

  it("sums a period, ranks the places, finds the unpressed ones", () => {
    const week = sumDays(log, 7, today);
    const before = sumDays(log, 7, today, 7);
    expect(topPlaces(config, week, before, "p1", device).map((p) => [p.binding.id, p.count, p.before])).toEqual([["hsv", 25, 0], ["copy", 5, 2]]);
    expect(unusedPlaces(config, week, "p1", device).map((b) => b.id)).toEqual(["hello"]);
  });

  it("counts the keys spared and hints a hold for a busy HyperShift action", () => {
    const week = sumDays(log, 7, today);
    expect(keystrokesOf(text("x", "hello"), new Map())).toBe(5);
    expect(savedKeystrokes(config, week)).toBe(5 * 1 + 25 * 1);
    expect(holdHints(config, week, "p1", device).map((h) => h.binding.id)).toEqual(["hsv"]);
    expect(layerHeat(week, "p1", "hypershift").get("thumb_01")).toBe(25);
  });

  it("names the menu items nobody picked, not links to other menus", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "i1", label: "C", actionId: "c", enabled: true },
      { kind: "submenu", id: "s", label: "S", enabled: true, items: [{ kind: "action", id: "i2", label: "Hi", actionId: "hi", enabled: true }] },
      { kind: "action", id: "link", label: "↪", actionId: "menu", enabled: true },
    ];
    const actions = new Map<string, Action>([["menu", { id: "menu", type: "menu", displayName: "M", payload: { items: [] } } as Action]]);
    expect([...unpickedItems(items, sumDays(log, 7, today), actions)]).toEqual(["i2"]);
  });
});
