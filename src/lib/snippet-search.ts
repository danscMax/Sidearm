import type { AppConfig, MenuItem, SnippetLibraryItem } from "./config";
import { otherLayout } from "./key-names";

/** How many places use each library text: buttons (enabled bindings) and menu
 *  items whose action links to it. */
export function snippetPlaceCounts(config: AppConfig): Map<string, number> {
  const snippetOf = new Map<string, string>();
  for (const action of config.actions) {
    if (action.type === "textSnippet" && action.payload.source === "libraryRef") snippetOf.set(action.id, action.payload.snippetId);
  }
  const counts = new Map<string, number>();
  const count = (actionId: string) => {
    const snippetId = snippetOf.get(actionId);
    if (snippetId) counts.set(snippetId, (counts.get(snippetId) ?? 0) + 1);
  };
  for (const binding of config.bindings) if (binding.enabled) count(binding.actionId);
  const walk = (items: MenuItem[]) => items.forEach((item) => {
    if (item.kind === "action") count(item.actionId);
    else if (item.kind === "submenu") walk(item.items);
  });
  for (const action of config.actions) if (action.type === "menu") walk(action.payload.items);
  return counts;
}

/** The library texts matching every word of `query` in their name, text or
 *  tags, typed on either keyboard layout; names that start with the query
 *  first, then other name matches, then the rest, each group in name order. */
export function searchSnippets(library: readonly SnippetLibraryItem[], query: string): SnippetLibraryItem[] {
  const sorted = [...library].sort((a, b) => a.name.localeCompare(b.name));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sorted;
  const has = (haystack: string, word: string) => haystack.includes(word) || haystack.includes(otherLayout(word));
  const rank = (snippet: SnippetLibraryItem): number => {
    const name = snippet.name.toLowerCase();
    const all = [name, snippet.text.toLowerCase(), ...snippet.tags.map((tag) => tag.toLowerCase())].join("\n");
    if (!words.every((word) => has(all, word))) return -1;
    const first = words[0]!;
    if (name.startsWith(first) || name.startsWith(otherLayout(first))) return 0;
    return words.every((word) => has(name, word)) ? 1 : 2;
  };
  return sorted
    .map((snippet) => ({ snippet, rank: rank(snippet) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.snippet);
}
