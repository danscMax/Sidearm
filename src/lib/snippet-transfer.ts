import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig, SnippetLibraryItem } from "./config";
import {
  isValidSnippetLibraryExport,
  type SnippetLibraryExportData,
} from "./config-editing";
// export_profile / import_profile are generic user-JSON file IO (write_user_json /
// read_user_json under the hood), reused here for the snippet library.
import { exportProfileFile, importProfileFile } from "./backend";

/** Mirror of profile-transfer for the whole snippet library: one native-dialog
 *  + backend call site, one validation step. */

/** Write the entire snippet library to a user-chosen `.json` file. Returns true
 *  if written, false if the dialog was cancelled. Throws on backend IO error. */
export async function exportSnippetLibraryToFile(
  config: AppConfig,
  dialogTitle: string,
  defaultName: string,
): Promise<boolean> {
  const data: SnippetLibraryExportData = {
    version: 2,
    exportedAt: new Date().toISOString(),
    snippets: config.snippetLibrary,
  };
  const filePath = await save({
    title: dialogTitle,
    defaultPath: `${defaultName}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof filePath !== "string") return false;
  await exportProfileFile(filePath, JSON.stringify(data, null, 2));
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
