import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "../public/menu.js?raw";

type Item = { label: string; number: number; enabled: boolean; submenu: boolean; detail?: string; text?: boolean; children?: string[]; textChildren?: boolean[] };
type View = { generation: number; title: string; query: string; highlight: number; items: Item[]; parent?: string; placeholder: string; empty: string; pickModes: string[]; maxHeight: number; searchAll?: boolean; hasOthers?: boolean; scopeAll?: string; scopeThis?: string };
let render: (event: { payload: View }) => void;
const calls: { command: string; args: Record<string, unknown> }[] = [];
const row = (label: string, extra: Partial<Item> = {}): Item => ({ label, number: 1, enabled: true, submenu: false, ...extra });
const view = (items: Item[], extra: Partial<View> = {}): View => ({ generation: 1, title: "Same", query: "", highlight: 0, items, placeholder: "Search", empty: "Empty", pickModes: ["Run", "Enter", "Copy", "Edit"], maxHeight: 900, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  const root = document.createElement("div");
  root.id = "menu";
  document.body.replaceChildren(root);
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
    invoke: (command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return Promise.resolve(); },
    transformCallback: (handler: typeof render) => { render = handler; return 1; },
  }, writable: true });
  vi.stubGlobal("ResizeObserver", undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
  new Function("window", "document", source)(window, document);
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("redraws same-title same-length levels and Back, but keeps rows on hover", () => {
  const root = view([row("Old"), row("Same", { submenu: true, children: ["New 1", "New 2"] })]);
  render({ payload: root });
  const child = view([row("New 1"), row("New 2")], { parent: "Same" });
  render({ payload: child });
  expect([...document.querySelectorAll(".label")].map(node => node.textContent)).toEqual(["New 1", "New 2"]);
  expect(document.querySelector(".back")?.textContent).toContain("Same");
  const first = document.querySelector(".row");
  render({ payload: { ...child, highlight: 1 } });
  expect(document.querySelector(".row")).toBe(first);
  render({ payload: { ...child, items: [row("Other 1"), row("Other 2")] } });
  expect([...document.querySelectorAll(".label")].map(node => node.textContent)).toEqual(["Other 1", "Other 2"]);
  render({ payload: root });
  expect(document.querySelector(".label")?.textContent).toBe("Old");
  expect(document.querySelector(".back")).toBeNull();
  document.querySelector<HTMLElement>(".row")!.click();
  expect(calls.at(-1)).toEqual({ command: "menu_pick", args: { index: 0 } });
});

it.each([false, true])("offers text modes only for text, including tip children (%s)", child => {
  render({ payload: view([child ? row("Submenu", { submenu: true, children: ["Ctrl+W", "Phrase"], textChildren: [false, true] }) : row("Ctrl+W", { detail: "Ctrl+W", text: false })]) });
  const target = document.querySelector(child ? ".tip__item" : ".row")!;
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect([...document.querySelectorAll(".tip__mode")].map(node => node.textContent)).toEqual(["Edit"]);
  if (child) {
    document.querySelectorAll(".tip__item")[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  } else {
    render({ payload: view([row("Phrase", { detail: "Text", text: true })]) });
    document.querySelector(".row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  }
  expect([...document.querySelectorAll(".tip__mode")].map(node => node.textContent)).toEqual(["Run", "Enter", "Copy", "Edit"]);
});

it.each([1, 2.25])("uses the physical work-area height at DPI %s and reveals the last row", dpr => {
  Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
  render({ payload: view(Array.from({ length: 80 }, (_, i) => row(`Phrase ${i + 1}`)), { highlight: 79 }) });
  expect(document.getElementById("menu")!.style.getPropertyValue("--menu-max-height")).toBe(`${900 / dpr}px`);
  expect(document.querySelectorAll(".row")[79].scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
});

it("keeps the active row visible when a scale change shrinks the list", () => {
  render({ payload: view(Array.from({ length: 80 }, (_, i) => row(`Phrase ${i + 1}`)), { highlight: 79 }) });
  vi.mocked(document.querySelectorAll(".row")[79].scrollIntoView).mockClear();
  Object.defineProperty(window, "devicePixelRatio", { value: 2.25, configurable: true });
  window.dispatchEvent(new Event("resize"));
  expect(document.querySelectorAll(".row")[79].scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
});

it("marks the matched part of a result and switches the search scope", () => {
  render({ payload: { ...view([row("Reply politely")]), query: "pol", hasOthers: true, searchAll: true, scopeAll: "All menus", scopeThis: "This menu" } as View });
  expect(document.querySelector(".label mark")?.textContent).toBe("pol");
  const scope = document.querySelector<HTMLButtonElement>(".scope")!;
  expect(scope.hidden).toBe(false);
  expect(scope.textContent).toBe("All menus");
  scope.click();
  expect(calls.at(-1)).toEqual({ command: "menu_search_scope", args: { all: false } });
  render({ payload: { ...view([row("Reply politely")]), query: "", hasOthers: false } as View });
  expect(document.querySelector(".label mark")).toBeNull();
  expect(document.querySelector<HTMLButtonElement>(".scope")!.hidden).toBe(true);
});
