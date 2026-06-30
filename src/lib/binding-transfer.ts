import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "./config";
import {
  buildBindingExport,
  isValidBindingExport,
  type BindingExportData,
} from "./config-editing";
// export_snippets / import_profile are generic user-JSON file IO; reused here.
import { exportSnippetsFile, importProfileFile } from "./backend";

/** Mirror of snippet-transfer for a single binding: native dialog + backend IO,
 *  one validation step. Format: `<name>.sidearm-binding.json`. */

/** Write one binding to a user-chosen `.sidearm-binding.json` file. Returns true
 *  if written, false if cancelled or the binding can't be assembled. */
export async function exportBindingToFile(
  config: AppConfig,
  bindingId: string,
  dialogTitle: string,
  defaultName: string,
): Promise<boolean> {
  const data = buildBindingExport(config, bindingId);
  if (!data) return false;

  const filePath = await save({
    title: dialogTitle,
    defaultPath: `${defaultName}.sidearm-binding.json`,
    filters: [{ name: "Sidearm binding", extensions: ["json"] }],
  });
  if (typeof filePath !== "string") return false;

  await exportSnippetsFile(filePath, JSON.stringify(data, null, 2));
  return true;
}

export type ImportBindingResult =
  | { status: "ok"; data: BindingExportData }
  | { status: "cancelled" }
  | { status: "invalid" };

/** Open + read + validate a single-binding export file. `cancelled`/`invalid`
 *  are non-throwing; backend IO / JSON parse errors throw for the caller's UI. */
export async function importBindingFromFile(dialogTitle: string): Promise<ImportBindingResult> {
  const filePath = await open({
    title: dialogTitle,
    filters: [{ name: "Sidearm binding", extensions: ["json"] }],
    multiple: false,
  });
  if (typeof filePath !== "string") return { status: "cancelled" };

  const raw = await importProfileFile(filePath);
  const data = JSON.parse(raw) as unknown;
  if (!isValidBindingExport(data)) return { status: "invalid" };
  return { status: "ok", data };
}
