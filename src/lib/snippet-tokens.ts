import { fixDatePattern, formatDatePattern, patternOf } from "./date-pattern";

/** The tokens the backend expands at send time — mirrors Rust
 *  `input_synthesis::SNIPPET_TOKENS` (`snippet-tokens.test.ts` reads that list);
 *  `{date:<pattern>}` and `{input:<name>}` (input_prompt.rs) too. */
export const SNIPPET_TOKENS = ["date", "time", "clipboard", "selection", "cursor", "|"] as const;

/** One run of a phrase as the backend reads it. `raw` is the source text, so
 *  the runs joined give the phrase back. `text`: what is typed (plain runs and
 *  `{{` / `}}` escapes); `token`: a token's name; `unknown`: a `{word}` the
 *  backend leaves as it is. */
export type SnippetPart =
  | { kind: "text"; raw: string; text: string }
  | { kind: "token"; raw: string; name: string }
  | { kind: "unknown"; raw: string; name: string };

function isKnown(name: string): boolean {
  return (SNIPPET_TOKENS as readonly string[]).includes(name) || name.startsWith("date:")
    || (name.startsWith("input:") && name.length > "input:".length);
}

/** Splits a phrase the way `expand_tokens_with` walks it: `{{` and `}}` are
 *  literal braces, `{` opens a token up to the next `}`, a lone brace is text. */
export function scanSnippet(text: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const pushText = (raw: string, typed: string) => {
    const last = parts.at(-1);
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", raw: last.raw + raw, text: last.text + typed };
    else parts.push({ kind: "text", raw, text: typed });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((c === "{" || c === "}") && text[i + 1] === c) {
      pushText(c + c, c);
      i += 2;
      continue;
    }
    if (c === "{") {
      const close = text.indexOf("}", i + 1);
      if (close >= 0) {
        const name = text.slice(i + 1, close);
        parts.push({ kind: isKnown(name) ? "token" : "unknown", raw: text.slice(i, close + 1), name });
        i = close + 1;
        continue;
      }
    }
    pushText(c, c);
    i += 1;
  }
  return parts;
}

/** A run of the preview line: typed text, or a stand-in for what is only known
 *  at send time (`placeholder`: "clipboard", "selection", "cursor" or an
 *  `{input:…}` field's name). */
export type PreviewPart = { text: string } | { placeholder: string; input?: boolean };

/** The phrase as it would be typed now: date and time filled, the rest as
 *  placeholders, line breaks as ↵ (one line). */
export function previewSnippet(text: string, now: Date, months: readonly string[]): PreviewPart[] {
  const out: PreviewPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out.at(-1);
    if (last && "text" in last) out[out.length - 1] = { text: last.text + value };
    else out.push({ text: value });
  };
  for (const part of scanSnippet(text)) {
    if (part.kind === "text") pushText(part.text.replace(/\r?\n/g, " ↵ "));
    else if (part.kind === "unknown") pushText(part.raw);
    else if (part.name === "date" || part.name === "time" || part.name.startsWith("date:")) {
      pushText(formatDatePattern(patternOf(part.raw), now, months));
    } else if (part.name.startsWith("input:")) out.push({ placeholder: part.name.slice("input:".length), input: true });
    else out.push({ placeholder: part.name === "|" ? "cursor" : part.name });
  }
  return out;
}

/** A likely mistake in a phrase: a `{word}` that is no token (with the closest
 *  one, if any), or a date pattern using letters the backend copies as is. */
export interface SnippetWarning {
  kind: "unknown" | "datePattern";
  raw: string;
  /** The token to put in its place. */
  fix?: string;
}

const WORD = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
const WORD_TOKENS = [...SNIPPET_TOKENS.filter((name) => name !== "|"), "input"];

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/** The token a misspelt `{word}` most likely meant (at most 2 edits away). */
function closestToken(word: string): string | undefined {
  const lower = word.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const name of WORD_TOKENS) {
    const d = distance(lower, name);
    if (d <= 2 && d < name.length && (!best || d < best.d)) best = { name, d };
  }
  if (!best) return undefined;
  return best.name === "input" ? `{input:${word}}` : `{${best.name}}`;
}

/** Warnings for a phrase, each mistake once. Plain `{…}` with spaces or
 *  punctuation (JSON, code) is not taken for a token. */
export function snippetWarnings(text: string): SnippetWarning[] {
  const out: SnippetWarning[] = [];
  const seen = new Set<string>();
  for (const part of scanSnippet(text)) {
    if (part.kind === "text" || seen.has(part.raw)) continue;
    if (part.kind === "unknown" && WORD.test(part.name)) {
      seen.add(part.raw);
      out.push({ kind: "unknown", raw: part.raw, fix: closestToken(part.name) });
    } else if (part.kind === "token" && part.name.startsWith("date:")) {
      const fixed = fixDatePattern(part.name.slice("date:".length));
      if (fixed) {
        seen.add(part.raw);
        out.push({ kind: "datePattern", raw: part.raw, fix: `{date:${fixed}}` });
      }
    }
  }
  return out;
}

/** The phrase with every `raw` token replaced by `fix` (escaped text untouched). */
export function replaceToken(text: string, raw: string, fix: string): string {
  return scanSnippet(text).map((part) => (part.kind !== "text" && part.raw === raw ? fix : part.raw)).join("");
}
