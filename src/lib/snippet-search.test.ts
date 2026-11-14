import { describe, expect, it } from "vitest";
import type { Action, SnippetLibraryItem } from "./config";
import { otherLayout } from "./key-names";
import { searchSnippets, snippetPlaceCounts } from "./snippet-search";
import { makeConfig } from "./test-fixtures";

const item = (id: string, name: string, text: string, tags: string[] = []): SnippetLibraryItem =>
  ({ id, name, text, tags, pasteMode: "sendText" });
const library = [
  item("sig", "Подпись", "С уважением,\nМаксим", ["почта"]),
  item("hi", "Привет", "Привет, {clipboard}!"),
  item("ssh", "SSH login", "ssh admin@server", ["terminal"]),
  item("deploy", "Deploy notes", "Привет команде, деплой готов"),
];
const names = (query: string) => searchSnippets(library, query).map((snippet) => snippet.id);

describe("library search", () => {
  it("lists everything in name order without a query", () => {
    expect(names("")).toEqual([...library].sort((a, b) => a.name.localeCompare(b.name)).map((snippet) => snippet.id));
    expect(names("  ")).toHaveLength(4);
  });

  it("finds by name, text and tag, every word", () => {
    expect(names("ssh")).toEqual(["ssh"]);
    expect(names("terminal")).toEqual(["ssh"]);
    expect(names("почта")).toEqual(["sig"]);
    expect(names("уважением максим")).toEqual(["sig"]);
    expect(names("ssh почта")).toEqual([]);
  });

  it("puts names that start with the query first, then other name matches, then text", () => {
    expect(names("привет")).toEqual(["hi", "deploy"]);
    expect(names("login")).toEqual(["ssh"]);
  });

  it("finds a query typed on the other layout", () => {
    expect(otherLayout("ghbdtn")).toBe("привет");
    expect(otherLayout("ыыр")).toBe("ssh");
    expect(names("ghbdtn")).toEqual(["hi", "deploy"]);
    expect(names("ыыр")).toEqual(["ssh"]);
  });
});

describe("library use counts", () => {
  it("counts the buttons and menu items using each text", () => {
    const ref = (id: string, snippetId: string): Action => ({ id, type: "textSnippet", displayName: id, payload: { source: "libraryRef", snippetId } });
    const config = makeConfig({
      actions: [
        ref("a1", "sig"), ref("a2", "sig"), ref("a3", "hi"),
        { id: "m", type: "menu", displayName: "Menu", payload: { items: [
          { kind: "action", id: "i1", label: "Sig", actionId: "a1", enabled: true },
          { kind: "submenu", id: "s", label: "More", enabled: true, items: [{ kind: "action", id: "i2", label: "Hi", actionId: "a3", enabled: true }] },
        ] } },
      ],
      bindings: [
        { id: "b1", profileId: "p1", controlId: "thumb_01", layer: "standard", actionId: "a1", enabled: true, label: "" },
        { id: "b2", profileId: "p1", controlId: "thumb_02", layer: "standard", actionId: "a2", enabled: true, label: "" },
        { id: "b3", profileId: "p1", controlId: "thumb_03", layer: "standard", actionId: "a3", enabled: false, label: "" },
      ],
    });
    const counts = snippetPlaceCounts(config);
    expect(counts.get("sig")).toBe(3);
    expect(counts.get("hi")).toBe(1);
    expect(counts.get("ssh")).toBeUndefined();
  });
});
