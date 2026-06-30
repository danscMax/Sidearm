import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig, SnippetLibraryItem } from "./config";
import {
  isValidSnippetLibraryExport,
  type SnippetLibraryExportData,
} from "./config-editing";
// export_profile / import_profile are generic user-JSON file IO (write_user_json /
// read_user_json under the hood), reused here for the snippet library.
import { exportSnippetsFile, importProfileFile } from "./backend";

/** Mirror of profile-transfer for the whole snippet library: one native-dialog
 *  + backend call site, one validation step. */

/** Markdown document: one `# heading` + body per snippet, blank-line separated. */
function snippetsToMarkdown(snippets: SnippetLibraryItem[]): string {
  return snippets.map((s) => `# ${s.name}\n\n${s.text}\n`).join("\n");
}

/** Plain text: snippet bodies only, separated by a horizontal rule. */
function snippetsToPlainText(snippets: SnippetLibraryItem[]): string {
  return snippets.map((s) => s.text).join("\n\n---\n\n");
}

/** Write the entire snippet library to a user-chosen file. Format follows the
 *  chosen extension: `.json` (re-importable), `.md` (document), `.txt` (bodies).
 *  Returns true if written, false if cancelled. Throws on backend IO error. */
export async function exportSnippetLibraryToFile(
  config: AppConfig,
  dialogTitle: string,
  defaultName: string,
): Promise<boolean> {
  const filePath = await save({
    title: dialogTitle,
    defaultPath: `${defaultName}.json`,
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "Markdown", extensions: ["md"] },
      { name: "Plain text", extensions: ["txt"] },
    ],
  });
  if (typeof filePath !== "string") return false;

  const lower = filePath.toLowerCase();
  let contents: string;
  if (lower.endsWith(".md")) {
    contents = snippetsToMarkdown(config.snippetLibrary);
  } else if (lower.endsWith(".txt")) {
    contents = snippetsToPlainText(config.snippetLibrary);
  } else {
    const data: SnippetLibraryExportData = {
      version: 2,
      exportedAt: new Date().toISOString(),
      snippets: config.snippetLibrary,
    };
    contents = JSON.stringify(data, null, 2);
  }
  await exportSnippetsFile(filePath, contents);
  return true;
}

export type ImportSnippetLibraryResult =
  | { status: "ok"; snippets: SnippetLibraryItem[] }
  | { status: "cancelled" }
  | { status: "invalid" };

/** Open + read + validate a snippet-library export file. `cancelled`/`invalid`
 *  are non-throwing; backend IO / JSON parse errors throw for the caller's UI. */
export async function importSnippetLibraryFromFile(
  dialogTitle: string,
): Promise<ImportSnippetLibraryResult> {
  const filePath = await open({
    title: dialogTitle,
    filters: [{ name: "JSON", extensions: ["json"] }],
    multiple: false,
  });
  if (typeof filePath !== "string") return { status: "cancelled" };

  const raw = await importProfileFile(filePath);
  const data = JSON.parse(raw) as unknown;
  if (!isValidSnippetLibraryExport(data)) return { status: "invalid" };
  return { status: "ok", snippets: data.snippets };
}
