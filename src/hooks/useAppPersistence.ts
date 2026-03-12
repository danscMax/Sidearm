import { startTransition, useState } from "react";

import { loadConfig, normalizeCommandError, saveConfig } from "../lib/backend";
import type {
  AppConfig,
  CommandError,
  LoadConfigResponse,
  SaveConfigResponse,
} from "../lib/config";
import type { ViewState } from "../lib/constants";

const MAX_UNDO = 15;

export type ConfirmModalOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
};

export interface AppPersistence {
  // State (read-only for consumers)
  viewState: ViewState;
  setViewState: React.Dispatch<React.SetStateAction<ViewState>>;
  snapshot: LoadConfigResponse | null;
  setSnapshot: React.Dispatch<React.SetStateAction<LoadConfigResponse | null>>;
  workingConfig: AppConfig | null;
  lastSave: SaveConfigResponse | null;
  setLastSave: React.Dispatch<React.SetStateAction<SaveConfigResponse | null>>;
  error: CommandError | null;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
  isDirty: boolean;
  undoStack: readonly AppConfig[];
  redoStack: readonly AppConfig[];

  // Derived
  activeConfig: AppConfig | null;
  activeWarnings: import("../lib/config").ValidationWarning[];
  activePath: string;

  // Functions
  refreshConfig: () => Promise<boolean>;
  persistConfig: (config: AppConfig) => Promise<void>;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  resetDraft: (showConfirmModal: (opts: ConfirmModalOptions) => void) => void;
  handleUndo: () => void;
  handleRedo: () => void;
}

export function useAppPersistence(): AppPersistence {
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [snapshot, setSnapshot] = useState<LoadConfigResponse | null>(null);
  const [workingConfig, setWorkingConfig] = useState<AppConfig | null>(null);
  const [lastSave, setLastSave] = useState<SaveConfigResponse | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<AppConfig[]>([]);
  const [redoStack, setRedoStack] = useState<AppConfig[]>([]);

  const activeConfig = workingConfig;
  const activeWarnings = lastSave?.warnings ?? snapshot?.warnings ?? [];
  const activePath = lastSave?.path ?? snapshot?.path ?? "Пока не загружен";

  async function refreshConfig(): Promise<boolean> {
    setViewState("loading");
    setError(null);

    try {
      const result = await loadConfig();
      startTransition(() => {
        setSnapshot(result);
        setWorkingConfig(result.config);
        setLastSave(null);
        setError(null);
        setIsDirty(false);
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

  async function persistConfig(config: AppConfig): Promise<void> {
    setViewState("saving");
    setError(null);

    try {
      const result = await saveConfig(config);
      startTransition(() => {
        setSnapshot({
          config: result.config,
          warnings: result.warnings,
          path: result.path,
          createdDefault: false,
        });
        setWorkingConfig(result.config);
        setLastSave(result);
        setError(null);
        setIsDirty(false);
        setViewState("ready");
      });
      // NOTE: Runtime reload removed from here.
      // Caller should chain runtime.reload() after awaiting persistConfig if needed.
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
        setViewState("error");
      });
    }
  }

  function updateDraft(updateConfig: (config: AppConfig) => AppConfig) {
    setWorkingConfig((current) => {
      if (!current) return current;
      // Push current state to undo stack (max MAX_UNDO)
      setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
      setRedoStack([]);
      setError(null);
      setIsDirty(true);
      setViewState("ready");
      return updateConfig(current);
    });
  }

  function resetDraft(showConfirmModal: (opts: ConfirmModalOptions) => void) {
    if (!snapshot) {
      return;
    }

    if (isDirty) {
      showConfirmModal({
        title: "Отменить изменения?",
        message: "Все несохранённые изменения будут потеряны.",
        confirmLabel: "Отменить изменения",
        onConfirm: () => {
          setWorkingConfig(snapshot.config);
          setError(null);
          setIsDirty(false);
          setUndoStack([]);
          setRedoStack([]);
          setViewState("ready");
        },
      });
      return;
    }

    setWorkingConfig(snapshot.config);
    setError(null);
    setIsDirty(false);
    setViewState("ready");
  }

  function handleUndo() {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1];
      const remaining = stack.slice(0, -1);
      setWorkingConfig((current) => {
        if (current) {
          setRedoStack((redo) => [...redo, current]);
        }
        return previous;
      });
      // Reference equality is intentional: snapshot.config preserves identity through save cycle
      setIsDirty(remaining.length > 0 || previous !== snapshot?.config);
      return remaining;
    });
  }

  function handleRedo() {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[stack.length - 1];
      const remaining = stack.slice(0, -1);
      setWorkingConfig((current) => {
        if (current) {
          setUndoStack((undo) => [...undo, current]);
        }
        return next;
      });
      setIsDirty(remaining.length > 0 || next !== snapshot?.config);
      return remaining;
    });
  }

  return {
    viewState,
    setViewState,
    snapshot,
    setSnapshot,
    workingConfig,
    lastSave,
    setLastSave,
    error,
    setError,
    isDirty,
    undoStack,
    redoStack,
    activeConfig,
    activeWarnings,
    activePath,
    refreshConfig,
    persistConfig,
    updateDraft,
    resetDraft,
    handleUndo,
    handleRedo,
  };
}
