import { describe, expect, it } from "vitest";
import rustSource from "../../src-tauri/src/input_synthesis.rs?raw";
import { fixDatePattern } from "./date-pattern";
import { previewSnippet, replaceToken, scanSnippet, SNIPPET_TOKENS, snippetWarnings } from "./snippet-tokens";

const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const now = new Date(2026, 10, 4, 9, 5, 7);

describe("snippet tokens", () => {
  it("lists the same tokens as the Rust expander", () => {
    const list = /const SNIPPET_TOKENS: \[&str; \d+\] = \[([^\]]*)\];/.exec(rustSource)?.[1];
    expect(list, "SNIPPET_TOKENS in input_synthesis.rs").toBeTypeOf("string");
    expect([...list!.matchAll(/"([^"]*)"/g)].map((m) => m[1])).toEqual([...SNIPPET_TOKENS]);
  });

  it("reads escapes, tokens and lone braces like the backend", () => {
    const text = "{{date}} {date} {x {clipbord} }} }";
    const parts = scanSnippet(text);
    expect(parts.map((part) => part.raw).join("")).toBe(text);
    // `{{date}}` is typed literally: no token in it.
    expect(parts.filter((part) => part.kind === "token").map((part) => part.raw)).toEqual(["{date}"]);
    // `{x {clipbord}`: the backend reads up to the first `}`.
    expect(parts.filter((part) => part.kind === "unknown").map((part) => part.raw)).toEqual(["{x {clipbord}"]);
    expect(scanSnippet("a {{b}} c")).toEqual([{ kind: "text", raw: "a {{b}} c", text: "a {b} c" }]);
  });

  it("previews a phrase with dates filled and the rest as placeholders", () => {
    expect(previewSnippet("{date:dd.MM.yyyy} {time}\n{clipboard}{|} {input:host} {{x}} {nope}", now, months)).toEqual([
      { text: "04.11.2026 09:05 ↵ " },
      { placeholder: "clipboard" },
      { placeholder: "cursor" },
      { text: " " },
      { placeholder: "host", input: true },
      { text: " {x} {nope}" },
    ]);
  });

  it("warns about unknown words with the closest token, and date letters of other formats", () => {
    expect(snippetWarnings("{clipbord} {Date} {foo} {clipbord} {a: 1} {date:YYYY-MM-DD} {date:dd.MM.yyyy} {{clipbord}}")).toEqual([
      { kind: "unknown", raw: "{clipbord}", fix: "{clipboard}" },
      { kind: "unknown", raw: "{Date}", fix: "{date}" },
      { kind: "unknown", raw: "{foo}", fix: undefined },
      { kind: "datePattern", raw: "{date:YYYY-MM-DD}", fix: "{date:yyyy-MM-dd}" },
    ]);
    expect(snippetWarnings("{selecton} {inptu}")).toEqual([
      { kind: "unknown", raw: "{selecton}", fix: "{selection}" },
      { kind: "unknown", raw: "{inptu}", fix: "{input:inptu}" },
    ]);
  });

  it("replaces a token everywhere but inside escapes", () => {
    expect(replaceToken("{clipbord} {{clipbord}} {clipbord}", "{clipbord}", "{clipboard}"))
      .toBe("{clipboard} {{clipbord}} {clipboard}");
  });

  it("puts date letters of other formats right", () => {
    expect(fixDatePattern("YYYY-MM-DD hh:mm")).toBe("yyyy-MM-dd HH:mm");
    expect(fixDatePattern("dd.MM.yyyy")).toBeNull();
  });
});
