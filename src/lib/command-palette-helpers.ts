import { bindingMatchesQuery } from "./conflict-detection";
import type { Action, Binding, SnippetLibraryItem } from "./config";

export type PaletteCommand = { id: string; label: string; shortcut?: string };

export type PaletteResults = {
  commands: PaletteCommand[];
  bindings: Binding[];
  snippets: SnippetLibraryItem[];
};

const SECTION_LIMIT = 25;

/**
 * Filter the command palette's data sources for a query.
 *
 * - Commands always shown (substring of label; everything when the query is empty).
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
  const commands = data.commands.filter((c) => !q || c.label.toLowerCase().includes(q));
  if (!q) return { commands, bindings: [], snippets: [] };

  const bindings = data.bindings
    .filter((b) => bindingMatchesQuery(b, data.actionsById.get(b.actionId) ?? null, q))
    .slice(0, SECTION_LIMIT);
  const snippets = data.snippets
    .filter((s) => s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
    .slice(0, SECTION_LIMIT);

  return { commands, bindings, snippets };
}
