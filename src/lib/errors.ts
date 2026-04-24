import type { TFunction } from "i18next";

import type { CommandError } from "./config";

export type ErrorActionKind =
  | "copyDetails"
  | "retry"
  | "openLastBackup"
  | "openConfigFolder"
  | "dismiss";

export interface ErrorAction {
  kind: ErrorActionKind;
  labelKey: string;
  primary?: boolean;
  danger?: boolean;
}

export interface TranslatedError {
  code: string;
  title: string;
  message: string;
  hint?: string;
  details?: string[];
  actions: ErrorAction[];
}

interface ErrorMapEntry {
  titleKey: string;
  hintKey?: string;
  actions: ErrorAction[];
}

const COPY_DETAILS: ErrorAction = {
  kind: "copyDetails",
  labelKey: "errors.actions.copyDetails",
};
const RETRY: ErrorAction = {
  kind: "retry",
  labelKey: "errors.actions.retry",
  primary: true,
};
const OPEN_LAST_BACKUP: ErrorAction = {
  kind: "openLastBackup",
  labelKey: "errors.actions.openLastBackup",
  primary: true,
};
const OPEN_CONFIG_FOLDER: ErrorAction = {
  kind: "openConfigFolder",
  labelKey: "errors.actions.openConfigFolder",
};
const DISMISS: ErrorAction = {
  kind: "dismiss",
  labelKey: "errors.actions.dismiss",
};

const ERROR_MAP: Record<string, ErrorMapEntry> = {
  schema_violation: {
    titleKey: "errors.schema.title",
    hintKey: "errors.schema.hint",
    actions: [COPY_DETAILS, OPEN_LAST_BACKUP, OPEN_CONFIG_FOLDER],
  },
  io_error: {
    titleKey: "errors.io.title",
    hintKey: "errors.io.hint",
    actions: [RETRY, OPEN_CONFIG_FOLDER, COPY_DETAILS],
  },
  parse_error: {
    titleKey: "errors.parse.title",
    hintKey: "errors.parse.hint",
    actions: [OPEN_LAST_BACKUP, COPY_DETAILS],
  },
  config_directory_unavailable: {
    titleKey: "errors.noConfigDir.title",
    hintKey: "errors.noConfigDir.hint",
    actions: [OPEN_CONFIG_FOLDER, COPY_DETAILS],
  },
  portable_readonly_fallback: {
    titleKey: "errors.portableFallback.title",
    hintKey: "errors.portableFallback.hint",
    actions: [OPEN_CONFIG_FOLDER, DISMISS],
  },
  invalid_config: {
    titleKey: "errors.invalidConfig.title",
    hintKey: "errors.invalidConfig.hint",
    actions: [OPEN_LAST_BACKUP, COPY_DETAILS],
  },
  invalid_backup_path: {
    titleKey: "errors.invalidBackupPath.title",
    hintKey: "errors.invalidBackupPath.hint",
    actions: [OPEN_CONFIG_FOLDER, DISMISS],
  },
  invalid_path: {
    titleKey: "errors.invalidPath.title",
    hintKey: "errors.invalidPath.hint",
    actions: [DISMISS, COPY_DETAILS],
  },
  runtime_reload_failed: {
    titleKey: "errors.runtimeReload.title",
    hintKey: "errors.runtimeReload.hint",
    actions: [RETRY, COPY_DETAILS],
  },
};

const DEFAULT_ENTRY: ErrorMapEntry = {
  titleKey: "errors.unknown.title",
  hintKey: "errors.unknown.hint",
  actions: [COPY_DETAILS, RETRY, DISMISS],
};

/**
 * Translate a raw `CommandError` into a human-readable `TranslatedError`.
 * The `details` field (often a list of raw JSON Schema violation paths) is
 * preserved verbatim so the UI can expose it under a "technical info"
 * disclosure — never directly in the headline message.
 */
export function translateCommandError(
  error: CommandError,
  t: TFunction,
): TranslatedError {
  const entry = ERROR_MAP[error.code] ?? DEFAULT_ENTRY;
  const title = t(entry.titleKey, error.code);
  const message = error.message || title;
  const hint = entry.hintKey ? t(entry.hintKey) : undefined;
  return {
    code: error.code,
    title,
    message,
    hint,
    details: error.details,
    actions: entry.actions,
  };
}

/**
 * Compose a copy-ready blob combining code, message, and details.
 * Used by the "Copy details" action button.
 */
export function formatErrorForClipboard(error: CommandError): string {
  const lines = [
    `[${error.code}] ${error.message}`,
    ...(error.details ?? []),
  ];
  return lines.join("\n");
}
