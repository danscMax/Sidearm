import type React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { CommandError } from "../lib/config";
import type {
  ActionExecutionEvent,
  RuntimeStateSummary,
  WindowCaptureResult,
  ResolvedInputPreview,
} from "../lib/runtime";

// ---------------------------------------------------------------------------
// Mock the backend module so we control IPC responses
// ---------------------------------------------------------------------------
vi.mock("../lib/backend", () => ({
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(),
  reloadRuntime: vi.fn(),
  rehookCapture: vi.fn(),
  captureActiveWindow: vi.fn(),
  previewResolution: vi.fn(),
  executePreviewAction: vi.fn(),
  runPreviewAction: vi.fn(),
  getDebugLog: vi.fn().mockResolvedValue([]),
  normalizeCommandError: vi.fn((e: unknown) => ({
    code: "command_error",
    message: String(e),
  })),
  listenRuntimeEvent: vi.fn().mockResolvedValue(() => {}),
  listenWindowResolutionEvent: vi.fn().mockResolvedValue(() => {}),
  listenEncodedKeyEvent: vi.fn().mockResolvedValue(() => {}),
  listenControlResolutionEvent: vi.fn().mockResolvedValue(() => {}),
  listenActionExecutionEvent: vi.fn().mockResolvedValue(() => {}),
  listenRuntimeErrorEvent: vi.fn().mockResolvedValue(() => {}),
}));

// Import AFTER vi.mock so the mock is in place
import { useRuntime } from "./useRuntime";
import {
  startRuntime,
  stopRuntime,
  reloadRuntime,
  rehookCapture,
  captureActiveWindow,
  previewResolution,
  executePreviewAction,
  runPreviewAction,
  getDebugLog,
} from "../lib/backend";

const mockedStartRuntime = vi.mocked(startRuntime);
const mockedStopRuntime = vi.mocked(stopRuntime);
const mockedReloadRuntime = vi.mocked(reloadRuntime);
const mockedRehookCapture = vi.mocked(rehookCapture);
const mockedCaptureActiveWindow = vi.mocked(captureActiveWindow);
const mockedPreviewResolution = vi.mocked(previewResolution);
const mockedExecutePreviewAction = vi.mocked(executePreviewAction);
const mockedRunPreviewAction = vi.mocked(runPreviewAction);
const mockedGetDebugLog = vi.mocked(getDebugLog);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const runningSummary: RuntimeStateSummary = {
  status: "running",
  startedAt: Date.now(),
  lastReloadAt: null,
  captureBackend: "windows-register-hotkey",
  activeConfigVersion: 1,
  warningCount: 0,
};

const stoppedSummary: RuntimeStateSummary = {
  status: "idle",
  startedAt: null,
  lastReloadAt: null,
  captureBackend: "windows-register-hotkey",
  activeConfigVersion: null,
  warningCount: 0,
};

const captureResult: WindowCaptureResult = {
  hwnd: "0x12345",
  exe: "notepad.exe",
  processPath: "C:\\Windows\\notepad.exe",
  title: "Untitled - Notepad",
  capturedAt: Date.now(),
  ignored: false,
  usedFallbackProfile: false,
  candidateAppMappingIds: [],
  resolutionReason: "matched",
  isElevated: false,
};

const resolutionPreview: ResolvedInputPreview = {
  status: "resolved",
  encodedKey: "F13",
  reason: "matched",
  usedFallbackProfile: false,
  candidateAppMappingIds: [],
  candidateControlIds: [],
};

const executionEvent: ActionExecutionEvent = {
  encodedKey: "F13",
  actionId: "act-1",
  actionType: "shortcut",
  actionPretty: "Ctrl+C",
  mode: "dryRun",
  outcome: "simulated",
  summary: "Would send Ctrl+C",
  warnings: [],
  executedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers past the 50ms debounce used by refreshDebugLog. */
async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(60);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useRuntime", () => {
  const setError = vi.fn() as unknown as React.Dispatch<React.SetStateAction<CommandError | null>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockedGetDebugLog.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Initial state
  // =========================================================================
  describe("initial state", () => {
    it("runtimeSummary has status 'idle'", async () => {
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      expect(result.current.runtimeSummary.status).toBe("idle");
      expect(result.current.runtimeSummary.startedAt).toBeNull();
      expect(result.current.runtimeSummary.activeConfigVersion).toBeNull();
    });
  });

  // =========================================================================
  // Lifecycle commands
  // =========================================================================
  describe("lifecycle commands", () => {
    it("handleStartRuntime calls start_runtime IPC and updates runtimeSummary", async () => {
      mockedStartRuntime.mockResolvedValue(runningSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleStartRuntime();
      });
      await flushDebounce();

      expect(mockedStartRuntime).toHaveBeenCalledTimes(1);
      expect(result.current.runtimeSummary).toEqual(runningSummary);
    });

    it("handleStopRuntime calls stop_runtime IPC and updates runtimeSummary", async () => {
      mockedStopRuntime.mockResolvedValue(stoppedSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleStopRuntime();
      });
      await flushDebounce();

      expect(mockedStopRuntime).toHaveBeenCalledTimes(1);
      expect(result.current.runtimeSummary).toEqual(stoppedSummary);
    });

    it("handleReloadRuntime calls reload_runtime IPC and updates runtimeSummary", async () => {
      const reloadedSummary: RuntimeStateSummary = {
        ...runningSummary,
        lastReloadAt: Date.now(),
        activeConfigVersion: 2,
      };
      mockedReloadRuntime.mockResolvedValue(reloadedSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleReloadRuntime();
      });
      await flushDebounce();

      expect(mockedReloadRuntime).toHaveBeenCalledTimes(1);
      expect(result.current.runtimeSummary).toEqual(reloadedSummary);
    });

    it("handleRehookCapture calls rehook_capture IPC (no state update)", async () => {
      mockedRehookCapture.mockResolvedValue(undefined);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      const summaryBefore = result.current.runtimeSummary;

      await act(async () => {
        await result.current.handleRehookCapture();
      });

      expect(mockedRehookCapture).toHaveBeenCalledTimes(1);
      // runtimeSummary should not change — rehookCapture returns void
      expect(result.current.runtimeSummary).toEqual(summaryBefore);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe("error handling", () => {
    it("handleStartRuntime sets error on IPC failure", async () => {
      mockedStartRuntime.mockRejectedValue("start failed");
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleStartRuntime();
      });
      await flushDebounce();

      expect(setError).toHaveBeenCalledWith({
        code: "command_error",
        message: "start failed",
      });
    });

    it("handleRehookCapture sets error on IPC failure", async () => {
      mockedRehookCapture.mockRejectedValue("rehook failed");
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleRehookCapture();
      });

      expect(setError).toHaveBeenCalledWith({
        code: "command_error",
        message: "rehook failed",
      });
    });
  });

  // =========================================================================
  // Semantic methods
  // =========================================================================
  describe("semantic methods", () => {
    it("ensureRuntimeStarted calls start_runtime and updates summary", async () => {
      mockedStartRuntime.mockResolvedValue(runningSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.ensureRuntimeStarted();
      });
      await flushDebounce();

      expect(mockedStartRuntime).toHaveBeenCalledTimes(1);
      expect(result.current.runtimeSummary).toEqual(runningSummary);
    });

    it("ensureRuntimeStarted throws on IPC failure (does NOT swallow)", async () => {
      mockedStartRuntime.mockRejectedValue(new Error("fatal"));
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await expect(result.current.ensureRuntimeStarted()).rejects.toThrow(
          "fatal",
        );
      });
    });

    it("clearRuntimeError sets lastRuntimeError to null", async () => {
      mockedStartRuntime.mockResolvedValue(runningSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      // lastRuntimeError is initially null, but clearRuntimeError should still work
      act(() => {
        result.current.clearRuntimeError();
      });
      expect(result.current.lastRuntimeError).toBeNull();
    });
  });

  // =========================================================================
  // Capture & resolution
  // =========================================================================
  describe("capture & resolution", () => {
    it("handleCaptureActiveWindow calls capture_active_window with captureDelayMs", async () => {
      mockedCaptureActiveWindow.mockResolvedValue(captureResult);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      // Default captureDelayMs is 2000
      await act(async () => {
        await result.current.handleCaptureActiveWindow();
      });
      await flushDebounce();

      expect(mockedCaptureActiveWindow).toHaveBeenCalledWith(2000);
      expect(result.current.lastCapture).toEqual(captureResult);
    });

    it("handlePreviewResolution calls preview_resolution with resolutionKeyInput", async () => {
      mockedPreviewResolution.mockResolvedValue(resolutionPreview);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      // Default resolutionKeyInput is "F13"
      await act(async () => {
        await result.current.handlePreviewResolution();
      });
      await flushDebounce();

      expect(mockedPreviewResolution).toHaveBeenCalledWith(
        "F13",
        undefined,
        undefined,
      );
      expect(result.current.lastResolutionPreview).toEqual(resolutionPreview);
    });

    it("handleExecutePreviewAction updates lastExecution and clears lastRuntimeError", async () => {
      mockedExecutePreviewAction.mockResolvedValue(executionEvent);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleExecutePreviewAction();
      });
      await flushDebounce();

      expect(mockedExecutePreviewAction).toHaveBeenCalledWith(
        "F13",
        undefined,
        undefined,
      );
      expect(result.current.lastExecution).toEqual(executionEvent);
      expect(result.current.lastRuntimeError).toBeNull();
    });

    it("handleRunPreviewAction updates lastExecution and clears lastRuntimeError", async () => {
      mockedRunPreviewAction.mockResolvedValue(executionEvent);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      await act(async () => {
        await result.current.handleRunPreviewAction();
      });
      await flushDebounce();

      expect(mockedRunPreviewAction).toHaveBeenCalledWith(
        "F13",
        undefined,
        undefined,
      );
      expect(result.current.lastExecution).toEqual(executionEvent);
      expect(result.current.lastRuntimeError).toBeNull();
    });
  });

  // =========================================================================
  // Debug log refresh
  // =========================================================================
  describe("debug log refresh", () => {
    it("refreshDebugLog fetches entries after debounce", async () => {
      const entries = [
        {
          id: 1,
          level: "info" as const,
          category: "runtime",
          message: "Started",
          createdAt: Date.now(),
        },
      ];
      mockedGetDebugLog.mockResolvedValue(entries);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      expect(result.current.debugLog).toEqual(entries);
    });

    it("lifecycle commands trigger refreshDebugLog", async () => {
      mockedStartRuntime.mockResolvedValue(runningSummary);
      const { result } = renderHook(() => useRuntime({ setError }));
      await flushDebounce();

      mockedGetDebugLog.mockClear();

      await act(async () => {
        await result.current.handleStartRuntime();
      });
      await flushDebounce();

      // refreshDebugLog is called inside runtimeCommand after success
      expect(mockedGetDebugLog).toHaveBeenCalled();
    });
  });
});
