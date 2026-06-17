import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig } from "./config";
import {
  extractProfileExport,
  isValidProfileExport,
  type ProfileExportData,
} from "./config-editing";
import { exportProfileFile, importProfileFile } from "./backend";

/**
 * Single export/import path shared by the Profiles and Settings views (FIXES
 * F009 + F015). One sanitization rule, one native-dialog + backend call site,
 * one validation step — the components keep only their distinct post-import
 * behavior (config update, selection, error UI).
 */

/**
 * Sanitize a profile name into a safe filename stem. Keeps ASCII alphanumerics,
 * Cyrillic, underscore and hyphen; everything else (spaces, slashes, dots, etc.)
 * collapses to `_`. The `.json` extension is appended by {@link exportProfileToFile},
 * so this returns the stem only. Module-private: the single export path is the
 * only sanitization consumer.
 */
function sanitizeProfileFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9а-яА-Я_-]/g, "_");
}

/**
 * Run the native save dialog with a sanitized `<name>.json` default path and
 * write the profile export through the backend. Returns `true` if a file was
 * written, `false` if the user cancelled the dialog. Throws on backend IO error
 * so the caller can map it to its own error UI.
 */
export async function exportProfileToFile(
  config: AppConfig,
  profileId: string,
  profileName: string,
  dialogTitle: string,
): Promise<boolean> {
  const data = extractProfileExport(config, profileId);
  const json = JSON.stringify(data, null, 2);
  const filePath = await save({
    title: dialogTitle,
    defaultPath: `${sanitizeProfileFilename(profileName)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof filePath !== "string") return false;
  await exportProfileFile(filePath, json);
  return true;
}

/** Discriminated outcome of {@link importProfileFromFile}. */
export type ImportProfileResult =
  | { status: "ok"; data: ProfileExportData }
  | { status: "cancelled" }
  | { status: "invalid" };

/**
 * Run the native open dialog, read + parse the chosen file through the backend,
 * and structurally validate it. Returns a discriminated result so the caller
 * decides messaging: `cancelled` (no dialog selection) and `invalid` (wrong
 * shape) are non-throwing; backend IO / JSON parse errors throw so the caller
 * can map them to its own error UI.
 */
export async function importProfileFromFile(
  dialogTitle: string,
): Promise<ImportProfileResult> {
  const filePath = await open({
    title: dialogTitle,
    filters: [{ name: "JSON", extensions: ["json"] }],
    multiple: false,
  });
  if (typeof filePath !== "string") return { status: "cancelled" };

  const raw = await importProfileFile(filePath);
  const data = JSON.parse(raw) as unknown;
  if (!isValidProfileExport(data)) return { status: "invalid" };
  return { status: "ok", data };
}
