import { describe, it, expect } from "vitest";
import { filterPaletteResults, type PaletteCommand } from "./command-palette-helpers";
import type { Action, Binding, SnippetLibraryItem } from "./config";

function binding(id: string, label: string, profileId = "main"): Binding {
  return {
    id,
    profileId,
    layer: "standard",
    controlId: "thumb_01",
    label,
    actionId: `${id}-action`,
    enabled: true,
  };
}

function snippet(id: string, name: string, text: string): SnippetLibraryItem {
  return { id, name, text, pasteMode: "sendText", tags: [] };
}

const COMMANDS: PaletteCommand[] = [
  { id: "undo", label: "Undo" },
  { id: "redo", label: "Redo" },
  { id: "reload", label: "Reload config" },
];

const ACTIONS = new Map<string, Action>();

describe("filterPaletteResults", () => {
  it("empty query: all commands, no bindings/snippets (Recent shown elsewhere)", () => {
    const r = filterPaletteResults("", {
      commands: COMMANDS,
      bindings: [binding("b1", "Paste"), binding("b2", "Copy")],
      actionsById: ACTIONS,
      snippets: [snippet("s1", "Greeting", "Hello")],
    });
    expect(r.commands).toHaveLength(3);
    expect(r.bindings).toHaveLength(0);
    expect(r.snippets).toHaveLength(0);
  });

  it("filters commands by label substring", () => {
    const r = filterPaletteResults("re", {
      commands: COMMANDS,
      bindings: [],
      actionsById: ACTIONS,
      snippets: [],
    });
    expect(r.commands.map((c) => c.id)).toEqual(["redo", "reload"]);
  });

  it("matches bindings cross-profile by label", () => {
    const r = filterPaletteResults("paste", {
      commands: COMMANDS,
      bindings: [
        binding("b1", "Paste plain", "main"),
        binding("b2", "Copy", "code"),
        binding("b3", "Paste rich", "code"),
      ],
      actionsById: ACTIONS,
      snippets: [],
    });
    expect(r.bindings.map((b) => b.id)).toEqual(["b1", "b3"]);
  });

  it("matches snippets by name or text", () => {
    const r = filterPaletteResults("hello", {
      commands: COMMANDS,
      bindings: [],
      actionsById: ACTIONS,
      snippets: [
        snippet("s1", "Greeting", "Hello world"),
        snippet("s2", "hello-name", "Hi"),
        snippet("s3", "Bye", "Goodbye"),
      ],
    });
    expect(r.snippets.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("caps each section at 25 results", () => {
    const many = Array.from({ length: 40 }, (_, i) => binding(`b${i}`, "Paste"));
    const r = filterPaletteResults("paste", {
      commands: COMMANDS,
      bindings: many,
      actionsById: ACTIONS,
      snippets: [],
    });
    expect(r.bindings).toHaveLength(25);
  });
});
