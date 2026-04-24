import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BackupEntry, CommandError } from "../lib/config";
import { listBackups, restoreConfigFromBackup } from "../lib/backend";
import { normalizeCommandError } from "../lib/backend";

export interface BackupListProps {
  onRestored: () => void;
  setError: (error: CommandError | null) => void;
  setConfirmModal: (
    modal: {
      title: string;
      message: string;
      confirmLabel: string;
      onConfirm: () => void;
    } | null,
  ) => void;
}

export function BackupList({
  onRestored,
  setError,
  setConfirmModal,
}: BackupListProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listBackups();
      setEntries(list);
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function handleRestore(entry: BackupEntry) {
    setConfirmModal({
      title: t("backup.restoreTitle"),
      message: t("backup.restoreMessage", { label: describeEntry(entry, t) }),
      confirmLabel: t("backup.restoreConfirm"),
      onConfirm: async () => {
        try {
          await restoreConfigFromBackup(entry.path);
          onRestored();
          await refresh();
        } catch (unknownError) {
          setError(normalizeCommandError(unknownError));
        }
      },
    });
  }

  if (loading) {
    return <p className="panel__muted">{t("backup.loading")}</p>;
  }

  if (entries.length === 0) {
    return <p className="panel__muted">{t("backup.empty")}</p>;
  }

  return (
    <table className="backup-list">
      <thead>
        <tr>
          <th>{t("backup.column.type")}</th>
          <th>{t("backup.column.modified")}</th>
          <th>{t("backup.column.size")}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.path}>
            <td>{describeEntry(entry, t)}</td>
            <td>{formatDate(entry.modifiedMs)}</td>
            <td>{formatBytes(entry.bytes)}</td>
            <td>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => handleRestore(entry)}
              >
                {t("backup.restoreButton")}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function describeEntry(
  entry: BackupEntry,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const kind = entry.kind;
  if (kind.kind === "rolling") {
    return t("backup.kind.rolling", { slot: kind.value });
  }
  if (kind.kind === "snapshot") {
    return t("backup.kind.snapshot", { date: kind.value });
  }
  return t("backup.kind.lastKnownGood");
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  return date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
