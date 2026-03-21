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
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  handleUndo: () => void;
  handleRedo: () => void;
}

export function useAppPersistence(onAutoSaved?: () => void): AppPersistence {
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

  const activeConfig = workingConfig;
  const activeWarnings = lastSave?.warnings ?? snapshot?.warnings ?? [];
  const activePath = lastSave?.path ?? snapshot?.path ?? "Пока не загружен";

  // Cleanup timer on unmount and prevent post-dispose scheduling
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  function scheduleSave(config: AppConfig) {
    saveQueueRef.current = config;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, AUTO_SAVE_DELAY_MS);
  }

  async function flushSave() {
    const config = saveQueueRef.current;
    if (!config || isSavingRef.current) return;

    saveQueueRef.current = null;
    isSavingRef.current = true;
    setViewState("saving");

    try {
      const result = await saveConfig(config);
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
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
        setViewState("error");
      });
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

  function updateDraft(updateConfig: (config: AppConfig) => AppConfig) {
    const current = workingConfig;
    if (!current) return;
    const next = updateConfig(current);
    setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
    setRedoStack([]);
    setError(null);
    setViewState("ready");
    setWorkingConfig(next);
    scheduleSave(next);
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
    scheduleSave(previous);
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
    scheduleSave(next);
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
