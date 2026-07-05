import { bindingMatchesQuery } from "./conflict-detection";
import type { Action, Binding, SnippetLibraryItem } from "./config";

export type PaletteCommand = { id: string; label: string; shortcut?: string };

export type PaletteResults = {
  commands: PaletteCommand[];
  bindings: Binding[];
  snippets: SnippetLibraryItem[];
};

const SECTION_LIMIT = 25;

/** True when every char of `needle` appears in `haystack` in order (gaps allowed). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Filter the command palette's data sources for a query.
 *
 * - Commands always shown; substring matches rank first (preserving their order),
 *   then subsequence/fuzzy matches ("np" → "New profile") are appended. Everything
 *   when the query is empty.
 * - Bindings/Snippets only contribute when there IS a query — cross-profile,
 *   both layers. Empty query keeps them empty (the empty state shows Recent).
 */
export function filterPaletteResults(
  query: string,
  data: {
    commands: PaletteCommand[];
    bindings: Binding[];
    actionsById: Map<string, Action>;
    snippets: SnippetLibraryItem[];
  },
): PaletteResults {
  const q = query.trim().toLowerCase();
  if (!q) return { commands: data.commands, bindings: [], snippets: [] };

  const substringCmds: PaletteCommand[] = [];
  const fuzzyCmds: PaletteCommand[] = [];
  for (const c of data.commands) {
    const label = c.label.toLowerCase();
    if (label.includes(q)) substringCmds.push(c);
    else if (isSubsequence(q, label)) fuzzyCmds.push(c);
  }
  const commands = [...substringCmds, ...fuzzyCmds];

  const bindings = data.bindings
    .filter((b) => bindingMatchesQuery(b, data.actionsById.get(b.actionId) ?? null, q))
    .slice(0, SECTION_LIMIT);
  const snippets = data.snippets
    .filter((s) => s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
    .slice(0, SECTION_LIMIT);

  return { commands, bindings, snippets };
}
