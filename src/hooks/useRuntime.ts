import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  captureActiveWindow,
  executePreviewAction,
  getDebugLog,
  listenActionExecutionEvent,
  listenControlResolutionEvent,
  listenEncodedKeyEvent,
  listenRuntimeErrorEvent,
  listenRuntimeEvent,
  listenWindowResolutionEvent,
  normalizeCommandError,
  previewResolution,
  rehookCapture,
  reloadRuntime,
  runPreviewAction,
  startRuntime,
  stopRuntime,
} from "../lib/backend";
import type { CommandError } from "../lib/config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  EncodedKeyEvent,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  RuntimeStateSummary,
  WindowCaptureResult,
} from "../lib/runtime";
import { idleRuntimeStateSummary } from "../lib/runtime";

export interface RuntimeControl {
  // State
  runtimeSummary: RuntimeStateSummary;
  debugLog: DebugLogEntry[];
  captureDelayMs: number;
  setCaptureDelayMs: React.Dispatch<React.SetStateAction<number>>;
  lastCapture: WindowCaptureResult | null;
  resolutionKeyInput: string;
  setResolutionKeyInput: React.Dispatch<React.SetStateAction<string>>;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  lastEncodedKey: EncodedKeyEvent | null;
  executionCounts: Map<string, number>;

  // Actions
  ensureRuntimeStarted: () => Promise<void>;
  clearRuntimeError: () => void;
  clearExecutionCounts: () => void;
  refreshDebugLog: () => Promise<void>;
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;
  handleRehookCapture: () => Promise<void>;
  handleCaptureActiveWindow: () => Promise<void>;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
}

export function useRuntime(deps: {
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
  onEncodedKeyEvent?: (event: EncodedKeyEvent) => void;
  onControlResolutionEvent?: (preview: ResolvedInputPreview) => void;
}): RuntimeControl {
  const { setError } = deps;

  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeStateSummary>(
    idleRuntimeStateSummary,
  );
  const [debugLog, setDebugLog] = useState<DebugLogEntry[]>([]);
  const [captureDelayMs, setCaptureDelayMs] = useState(2000);
  const [lastCapture, setLastCapture] = useState<WindowCaptureResult | null>(null);
  const [resolutionKeyInput, setResolutionKeyInput] = useState("F13");
  const [lastResolutionPreview, setLastResolutionPreview] =
    useState<ResolvedInputPreview | null>(null);
  const [lastExecution, setLastExecution] = useState<ActionExecutionEvent | null>(null);
  const [lastRuntimeError, setLastRuntimeError] = useState<RuntimeErrorEvent | null>(null);
  const [lastEncodedKey, setLastEncodedKey] = useState<EncodedKeyEvent | null>(null);
  const [executionCounts, setExecutionCounts] = useState<Map<string, number>>(new Map());

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- useEffectEvent handlers for Tauri listeners ---

  const handleRuntimeEvent = useEffectEvent((summary: RuntimeStateSummary) => {
    startTransition(() => {
      setRuntimeSummary(summary);
    });
    void refreshDebugLog();
  });

  const handleWindowResolutionEvent = useEffectEvent((result: WindowCaptureResult) => {
    startTransition(() => {
      setLastCapture(result);
    });
    void refreshDebugLog();
  });

  const handleEncodedKeyEvent = useEffectEvent((event: EncodedKeyEvent) => {
    startTransition(() => {
      setLastEncodedKey(event);
    });
    deps.onEncodedKeyEvent?.(event);
    void refreshDebugLog();
  });

  const handleControlResolutionEvent = useEffectEvent((result: ResolvedInputPreview) => {
    startTransition(() => {
      setLastResolutionPreview(result);
    });
    deps.onControlResolutionEvent?.(result);
    void refreshDebugLog();
  });

  const handleActionExecutionEvent = useEffectEvent((event: ActionExecutionEvent) => {
    startTransition(() => {
      setLastExecution(event);
      setLastRuntimeError(null);
      const cid = event.controlId;
      if (event.mode === "live" && cid) {
        setExecutionCounts((prev) => {
          const next = new Map(prev);
          next.set(cid, (next.get(cid) ?? 0) + 1);
          return next;
        });
      }
    });
    void refreshDebugLog();
  });

  const handleRuntimeErrorEvent = useEffectEvent((event: RuntimeErrorEvent) => {
    startTransition(() => {
      setLastRuntimeError(event);
    });
    void refreshDebugLog();
  });

  // --- Tauri event listeners ---

  useEffect(() => {
    void refreshDebugLog();

    let disposed = false;
    let unlistenFns: Array<() => void> = [];

    async function attachRuntimeListeners() {
      const listeners = await Promise.all([
        listenRuntimeEvent("runtime_started", handleRuntimeEvent),
        listenRuntimeEvent("runtime_stopped", handleRuntimeEvent),
        listenRuntimeEvent("config_reloaded", handleRuntimeEvent),
        listenEncodedKeyEvent("encoded_key_received", handleEncodedKeyEvent),
        listenWindowResolutionEvent("profile_resolved", handleWindowResolutionEvent),
        listenControlResolutionEvent("control_resolved", handleControlResolutionEvent),
        listenActionExecutionEvent("action_executed", handleActionExecutionEvent),
        listenRuntimeErrorEvent("runtime_error", handleRuntimeErrorEvent),
      ]);

      if (disposed) {
        listeners.forEach((unlisten) => {
          void unlisten();
        });
        return;
      }

      unlistenFns = listeners;
    }

    void attachRuntimeListeners().catch((error) => {
      console.error("Failed to attach runtime listeners:", error);
    });

    return () => {
      disposed = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unlistenFns.forEach((unlisten) => {
        void unlisten();
      });
    };
  }, []);

  // --- Action functions ---

  async function refreshDebugLog() {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(async () => {
      refreshTimerRef.current = null;
      try {
        const entries = await getDebugLog();
        startTransition(() => {
          setDebugLog(entries);
        });
      } catch (unknownError) {
        startTransition(() => {
          setError(normalizeCommandError(unknownError));
        });
      }
    }, 50); // 50ms debounce - groups rapid successive events
  }

  async function runtimeCommand<T>(
    command: () => Promise<T>,
    onSuccess: (result: T) => void,
  ) {
    try {
      const result = await command();
      startTransition(() => onSuccess(result));
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function ensureRuntimeStarted(): Promise<void> {
    try {
      const summary = await startRuntime();
      startTransition(() => setRuntimeSummary(summary));
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
      throw unknownError;
    }
  }

  function clearRuntimeError() {
    startTransition(() => setLastRuntimeError(null));
  }

  function clearExecutionCounts() {
    startTransition(() => setExecutionCounts(new Map()));
  }

  async function handleStartRuntime() {
    await runtimeCommand(() => startRuntime(), (summary) => setRuntimeSummary(summary));
  }

  async function handleReloadRuntime() {
    await runtimeCommand(() => reloadRuntime(), (summary) => setRuntimeSummary(summary));
  }

  async function handleStopRuntime() {
    await runtimeCommand(() => stopRuntime(), (summary) => setRuntimeSummary(summary));
  }

  async function handleRehookCapture() {
    try {
      await rehookCapture();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleCaptureActiveWindow() {
    await runtimeCommand(
      () => captureActiveWindow(captureDelayMs),
      (result) => setLastCapture(result),
    );
  }

  async function handlePreviewResolution() {
    await runtimeCommand(
      () => previewResolution(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      ),
      (result) => setLastResolutionPreview(result),
    );
  }

  async function handleExecutePreviewAction() {
    await runtimeCommand(
      () => executePreviewAction(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      ),
      (result) => { setLastExecution(result); setLastRuntimeError(null); },
    );
  }

  async function handleRunPreviewAction() {
    await runtimeCommand(
      () => runPreviewAction(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      ),
      (result) => { setLastExecution(result); setLastRuntimeError(null); },
    );
  }

  return {
    runtimeSummary,
    debugLog,
    captureDelayMs,
    setCaptureDelayMs,
    lastCapture,
    resolutionKeyInput,
    setResolutionKeyInput,
    lastResolutionPreview,
    lastExecution,
    lastRuntimeError,
    lastEncodedKey,
    executionCounts,
    ensureRuntimeStarted,
    clearRuntimeError,
    clearExecutionCounts,
    refreshDebugLog,
    handleStartRuntime,
    handleReloadRuntime,
    handleStopRuntime,
    handleRehookCapture,
    handleCaptureActiveWindow,
    handlePreviewResolution,
    handleExecutePreviewAction,
    handleRunPreviewAction,
  };
}
