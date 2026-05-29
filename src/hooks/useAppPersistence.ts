import { startTransition, useEffect, useRef, useState } from "react";

import { loadConfig, normalizeCommandError, saveConfig } from "../lib/backend";
import type {
  AppConfig,
  CommandError,
  LoadConfigResponse,
  SaveConfigResponse,
} from "../lib/config";
import type { ViewState } from "../lib/constants";

const MAX_UNDO = 15;
const AUTO_SAVE_DELAY_MS = 500;

export interface UpdateDraftOptions {
  /**
   * Skip the 500 ms debounce and flush the save immediately. Use for explicit
   * commit moments (Save button in a modal, import, profile switch) where
   * losing the change to a subsequent rapid action or app close would surprise
   * the user. Default false — interactive typing should remain debounced.
   */
  immediate?: boolean;
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
  activeWarnings: import("../lib/config").ValidationWarning[];
  activePath: string;

  // Functions
  refreshConfig: () => Promise<boolean>;
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
  const onAutoSavedRef = useRef(onAutoSaved);
  onAutoSavedRef.current = onAutoSaved;
  const onAutoSaveFailedRef = useRef(onAutoSaveFailed);
  onAutoSaveFailedRef.current = onAutoSaveFailed;
  // Mirror of the last successfully-persisted config. Used to roll back the
  // in-memory working config when an auto-save fails (schema rejection,
  // backend error, etc.) so the UI cannot diverge from disk.
  const lastPersistedConfigRef = useRef<AppConfig | null>(null);

  const activeConfig = workingConfig;
  const activeWarnings = lastSave?.warnings ?? snapshot?.warnings ?? [];
  const activePath = lastSave?.path ?? snapshot?.path ?? "Пока не загружен";

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
      onAutoSavedRef.current?.();
    } catch (unknownError) {
      const normalized = normalizeCommandError(unknownError);
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
      // If new changes queued during save, save again promptly (skip if unmounted)
      if (saveQueueRef.current && !disposedRef.current) {
        saveTimerRef.current = setTimeout(flushSave, 100);
      }
    }
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
    setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
    setRedoStack([]);
    setError(null);
    setViewState("ready");
    setWorkingConfig(next);
    scheduleSave(next, options?.immediate ?? false);
  }

  function handleUndo() {
    if (undoStack.length === 0) return;
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
    updateDraft,
    handleUndo,
    handleRedo,
  };
}
