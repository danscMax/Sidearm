import { startTransition, useEffect, useRef, useState } from "react";

import { loadConfig, normalizeCommandError, saveConfig, verifyOnboardMapping } from "../lib/backend";
import { onboardBindings } from "../lib/onboard-mapping";
import i18n from "../i18n";
import type {
  AppConfig,
  CommandError,
  LoadConfigResponse,
  SaveConfigResponse,
  ValidationWarning,
} from "../lib/config";
import type { ViewState } from "../lib/constants";

const MAX_UNDO = 15;
const AUTO_SAVE_DELAY_MS = 500;

interface UpdateDraftOptions {
  /**
   * Skip the 500 ms debounce and flush the save immediately. Use for explicit
   * commit moments (Save button in a modal, import, profile switch) where
   * losing the change to a subsequent rapid action or app close would surprise
   * the user. Default false — interactive typing should remain debounced.
   */
  immediate?: boolean;
  /**
   * Collapse consecutive edits sharing the same key into ONE undo step. Without
   * it, typing N characters into a name/text field pushes N undo entries,
   * evicting earlier destructive actions (e.g. a profile delete) out of the
   * 15-deep stack. Use a per-field key like `snippet-name:<id>`. The first edit
   * of a run snapshots the pre-edit state; subsequent same-key edits don't push.
   */
  coalesceKey?: string;
}

export interface AppPersistence {
  // State (read-only for consumers)
  viewState: ViewState;
  snapshot: LoadConfigResponse | null;
  workingConfig: AppConfig | null;
  lastSave: SaveConfigResponse | null;
  error: CommandError | null;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
  undoStack: readonly AppConfig[];
  redoStack: readonly AppConfig[];

  // Derived
  activeConfig: AppConfig | null;
  activeWarnings: ValidationWarning[];
  activePath: string;

  // Functions
  refreshConfig: () => Promise<boolean>;
  refreshAfterSave: () => Promise<boolean>;
  updateDraft: (
    updateConfig: (config: AppConfig) => AppConfig,
    options?: UpdateDraftOptions,
  ) => void;
  handleUndo: () => void;
  handleRedo: () => void;
}

export function useAppPersistence(
  onAutoSaved?: () => void,
  onAutoSaveFailed?: (reason: string) => void,
  onBackupFailed?: () => void,
  onOnboardWriteFailed?: (reason: string) => void,
): AppPersistence {
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [snapshot, setSnapshot] = useState<LoadConfigResponse | null>(null);
  const [workingConfig, setWorkingConfig] = useState<AppConfig | null>(null);
  const [lastSave, setLastSave] = useState<SaveConfigResponse | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [undoStack, setUndoStack] = useState<AppConfig[]>([]);
  const [redoStack, setRedoStack] = useState<AppConfig[]>([]);

  // Auto-save refs
  const saveQueueRef = useRef<AppConfig | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isSavingRef = useRef(false);
  const disposedRef = useRef(false);
  /** The key-button signals last sent to the mouse (`null` = none this session). */
  const onboardSentRef = useRef<string | null>(null);
  const onAutoSavedRef = useRef(onAutoSaved);
  onAutoSavedRef.current = onAutoSaved;
  const onAutoSaveFailedRef = useRef(onAutoSaveFailed);
  onAutoSaveFailedRef.current = onAutoSaveFailed;
  const onBackupFailedRef = useRef(onBackupFailed);
  onBackupFailedRef.current = onBackupFailed;
  const onOnboardWriteFailedRef = useRef(onOnboardWriteFailed);
  onOnboardWriteFailedRef.current = onOnboardWriteFailed;
  // Warn only once per session that best-effort backups can't be written.
  const backupWarnedRef = useRef(false);
  // Mirror of the last successfully-persisted config. Used to roll back the
  // in-memory working config when an auto-save fails (schema rejection,
  // backend error, etc.) so the UI cannot diverge from disk.
  const lastPersistedConfigRef = useRef<AppConfig | null>(null);
  // Last updateDraft coalesce key — consecutive edits with the same key share one
  // undo step instead of one-per-keystroke (see UpdateDraftOptions.coalesceKey).
  const lastCoalesceKeyRef = useRef<string | null>(null);

  const activeConfig = workingConfig;
  const activeWarnings = lastSave?.warnings ?? snapshot?.warnings ?? [];
  const activePath = lastSave?.path ?? snapshot?.path ?? i18n.t("common.notLoadedYet");

  // Best-effort flush on unmount / window close. Previously this cleanup
  // wiped the pending queue without writing — if the user closed the app
  // within 500 ms of an edit, the change was silently lost. We now kick a
  // synchronous-from-caller-perspective flush so the in-flight save reaches
  // disk before React tears the hook down. (saveConfig is async but the
  // backend persists atomically; tauri keeps the runtime alive until the
  // command completes.)
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      clearTimeout(saveTimerRef.current);
      if (saveQueueRef.current) {
        void flushSave();
      }
    };
  }, []);

  // Same idea for hard browser/window unload — beforeunload fires when the
  // user closes the Tauri window. Sending the save request before unmount
  // gives Tauri a chance to drain it.
  useEffect(() => {
    function handleBeforeUnload() {
      if (saveQueueRef.current) {
        clearTimeout(saveTimerRef.current);
        void flushSave();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  function scheduleSave(config: AppConfig, immediate: boolean) {
    saveQueueRef.current = config;
    clearTimeout(saveTimerRef.current);
    if (immediate) {
      void flushSave();
    } else {
      saveTimerRef.current = setTimeout(flushSave, AUTO_SAVE_DELAY_MS);
    }
  }

  // The mouse keeps its own button signals, so a config whose signals changed
  // has to reach the mouse too; this writes each binding and lets the mouse
  // confirm it. Only a change is written: the signals rarely change (never for
  // the built-in Naga, whose codes the UI hides), and rewriting all of them on
  // every save failed whenever the mouse slept. The first save of a session only
  // records them — the backend guard put the mouse in line at start, and it
  // also retries a write that failed here. A failure is not a config failure,
  // so it is a warning instead of rolling the just-saved config back.
  async function writeOnboardMapping(config: AppConfig) {
    const bindings = onboardBindings(config);
    const signature = JSON.stringify(bindings);
    const previous = onboardSentRef.current;
    onboardSentRef.current = signature;
    if (bindings.length === 0 || previous === null || previous === signature) return;
    try {
      const report = await verifyOnboardMapping(bindings);
      if (report.failed.length > 0) {
        onOnboardWriteFailedRef.current?.(report.failed.join(", "));
      }
    } catch (unknownError) {
      const error = normalizeCommandError(unknownError);
      // No onboard-path mouse plugged in: the guard writes it when one appears.
      if (error.code === "onboard_not_connected") return;
      onOnboardWriteFailedRef.current?.(error.message);
    }
  }

  async function flushSave() {
    const config = saveQueueRef.current;
    if (!config || isSavingRef.current) return;

    saveQueueRef.current = null;
    isSavingRef.current = true;
    setViewState("saving");

    try {
      const result = await saveConfig(config);
      lastPersistedConfigRef.current = result.config;
      startTransition(() => {
        setSnapshot({
          config: result.config,
          warnings: result.warnings,
          path: result.path,
          createdDefault: false,
        });
        setLastSave(result);
        setError(null);
        setViewState("ready");
      });
      await writeOnboardMapping(result.config);
      onAutoSavedRef.current?.();
      if (result.backupFailed && !backupWarnedRef.current) {
        backupWarnedRef.current = true;
        onBackupFailedRef.current?.();
      }
    } catch (unknownError) {
      const normalized = normalizeCommandError(unknownError);
      // Another Sidearm instance wrote config.json after we loaded it (e.g. the
      // elevated autostart instance vs a manual launch). Don't surface an error
      // or roll back — reload the newer config from disk so we adopt its edits
      // instead of clobbering them. Prevents the concurrent-instance data loss.
      if (normalized.code === "config_changed_on_disk") {
        await refreshConfig();
        return;
      }
      const rollbackTarget = lastPersistedConfigRef.current;
      startTransition(() => {
        setError(normalized);
        setViewState("error");
        // Roll back in-memory draft to the last persisted snapshot to keep
        // UI and disk consistent. Without this, the working config holds the
        // rejected payload forever — modals reopen with empty/wrong fields
        // and runtime keeps using the older on-disk config.
        if (rollbackTarget) {
          setWorkingConfig(rollbackTarget);
        }
      });
      onAutoSaveFailedRef.current?.(normalized.message);
    } finally {
      isSavingRef.current = false;
      // If new changes queued during this save, drain them. On teardown
      // (unmount / window close) flush immediately rather than via a timer:
      // the timer path was skipped when disposed, silently dropping an edit
      // made within the debounce window while a save was already in flight.
      if (saveQueueRef.current) {
        if (disposedRef.current) {
          void flushSave();
        } else {
          saveTimerRef.current = setTimeout(flushSave, 100);
        }
      }
    }
  }

  /** Saves a pending edit first, then reloads: for a config the backend
   *  changed itself (a newly connected mouse got its device). */
  async function refreshAfterSave(): Promise<boolean> {
    // A save in flight drains the queue itself; wait until both are done.
    while (isSavingRef.current || saveQueueRef.current) {
      clearTimeout(saveTimerRef.current);
      if (isSavingRef.current) await new Promise((resolve) => setTimeout(resolve, 50));
      else await flushSave();
    }
    return refreshConfig();
  }

  async function refreshConfig(): Promise<boolean> {
    // Cancel any pending auto-save
    clearTimeout(saveTimerRef.current);
    saveQueueRef.current = null;

    setViewState("loading");
    setError(null);

    try {
      const result = await loadConfig();
      lastPersistedConfigRef.current = result.config;
      startTransition(() => {
        setSnapshot(result);
        setWorkingConfig(result.config);
        setLastSave(null);
        setError(null);
        setViewState("ready");
      });
      await writeOnboardMapping(result.config);
      return true;
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
        setViewState("error");
      });
      return false;
    }
  }

  function updateDraft(
    updateConfig: (config: AppConfig) => AppConfig,
    options?: UpdateDraftOptions,
  ) {
    const current = workingConfig;
    if (!current) return;
    const next = updateConfig(current);
    // Coalesce a run of same-key edits into one undo step: only the first edit
    // of the run snapshots the pre-edit state; the rest reuse it.
    const coalesceKey = options?.coalesceKey ?? null;
    const continuingRun = coalesceKey !== null && coalesceKey === lastCoalesceKeyRef.current;
    lastCoalesceKeyRef.current = coalesceKey;
    if (!continuingRun) {
      setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
    }
    setRedoStack([]);
    setError(null);
    setViewState("ready");
    setWorkingConfig(next);
    scheduleSave(next, options?.immediate ?? false);
  }

  function handleUndo() {
    if (undoStack.length === 0) return;
    lastCoalesceKeyRef.current = null;
    const previous = undoStack[undoStack.length - 1];
    const current = workingConfig;
    setUndoStack(undoStack.slice(0, -1));
    if (current) {
      setRedoStack((redo) => [...redo, current]);
    }
    setWorkingConfig(previous);
    scheduleSave(previous, false);
  }

  function handleRedo() {
    if (redoStack.length === 0) return;
    lastCoalesceKeyRef.current = null;
    const next = redoStack[redoStack.length - 1];
    const current = workingConfig;
    setRedoStack(redoStack.slice(0, -1));
    if (current) {
      setUndoStack((undo) => [...undo, current]);
    }
    setWorkingConfig(next);
    scheduleSave(next, false);
  }

  return {
    viewState,
    snapshot,
    workingConfig,
    lastSave,
    error,
    setError,
    undoStack,
    redoStack,
    activeConfig,
    activeWarnings,
    activePath,
    refreshConfig,
    refreshAfterSave,
    updateDraft,
    handleUndo,
    handleRedo,
  };
}
