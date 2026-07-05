import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BackupEntry, CommandError } from "../lib/config";
import {
  importFullConfigPreview,
  listBackups,
  restoreConfigFromBackup,
} from "../lib/backend";
import { normalizeCommandError } from "../lib/backend";
import type { ConfirmModalRequest } from "./ConfirmModal";

export interface BackupListProps {
  onRestored: () => void | Promise<unknown>;
  setError: (error: CommandError | null) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
}

const SNAPSHOT_COLLAPSE_THRESHOLD = 3;

export function BackupList({
  onRestored,
  setError,
  setConfirmModal,
}: BackupListProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllSnapshots, setShowAllSnapshots] = useState(false);

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

  // Auto backups: rolling + last-known-good. Daily snapshots: dated snapshots.
  const { autoEntries, snapshotEntries } = useMemo(() => {
    const auto = entries.filter((e) => e.kind.kind !== "snapshot");
    const snapshots = entries.filter((e) => e.kind.kind === "snapshot");
    return { autoEntries: auto, snapshotEntries: snapshots };
  }, [entries]);

  async function handleRestore(entry: BackupEntry) {
    // Show what the backup contains before overwriting the live config
    // (mirrors the full-config ImportPreview). Best-effort: if the peek
    // fails, the plain confirm still works — restore validates for real.
    let contents = "";
    try {
      const preview = await importFullConfigPreview(entry.path);
      contents = t("backup.restoreContents", {
        profiles: preview.profileCount,
        bindings: preview.bindingCount,
        actions: preview.actionCount,
        snippets: preview.snippetCount,
      });
    } catch {
      // ignore — preview is informational only
    }
    setConfirmModal({
      title: t("backup.restoreTitle"),
      message:
        t("backup.restoreMessage", { label: describeEntry(entry, t) }) +
        (contents ? ` ${contents}` : ""),
      confirmLabel: t("backup.restoreConfirm"),
      onConfirm: async () => {
        try {
          await restoreConfigFromBackup(entry.path);
          await onRestored();
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

  const visibleSnapshots = showAllSnapshots
    ? snapshotEntries
    : snapshotEntries.slice(0, SNAPSHOT_COLLAPSE_THRESHOLD);
  const hiddenSnapshotCount = snapshotEntries.length - visibleSnapshots.length;

  const renderGroup = (groupEntries: BackupEntry[]) =>
    groupEntries.map((entry) => (
      <div
        key={entry.path}
        className={`backup-item backup-item--${entry.kind.kind}`}
      >
        <div className="backup-item__main">
          <span className="backup-item__label">{describeEntry(entry, t)}</span>
          <span className="backup-item__meta">
            {formatDate(entry.modifiedMs)} · {formatBytes(entry.bytes)}
          </span>
        </div>
        <button
          type="button"
          className="backup-item__restore"
          onClick={() => void handleRestore(entry)}
        >
          {t("backup.restoreButton")}
        </button>
      </div>
    ));

  return (
    <div className="backup-groups">
      {autoEntries.length > 0 ? (
        <div className="backup-group">
          <div className="backup-group__title">{t("backup.groupAuto")}</div>
          <div className="backup-group__items">{renderGroup(autoEntries)}</div>
        </div>
      ) : null}

      {snapshotEntries.length > 0 ? (
        <div className="backup-group">
          <div className="backup-group__title">{t("backup.groupSnapshots")}</div>
          <div className="backup-group__items">{renderGroup(visibleSnapshots)}</div>
          {hiddenSnapshotCount > 0 ? (
            <button
              type="button"
              className="backup-group__expander"
              onClick={() => setShowAllSnapshots(true)}
            >
              {t("backup.showAll", { count: hiddenSnapshotCount })}
            </button>
          ) : null}
          {showAllSnapshots && snapshotEntries.length > SNAPSHOT_COLLAPSE_THRESHOLD ? (
            <button
              type="button"
              className="backup-group__expander"
              onClick={() => setShowAllSnapshots(false)}
            >
              {t("backup.showFewer")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
