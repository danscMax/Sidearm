import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type {
  AppConfig,
  LoadConfigResponse,
  SaveConfigResponse,
} from "../lib/config";
import { makeConfig } from "../lib/test-fixtures";

// ---------------------------------------------------------------------------
// Mock the backend module so we control IPC responses
// ---------------------------------------------------------------------------
vi.mock("../lib/backend", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  normalizeCommandError: vi.fn((err: unknown) => {
    if (typeof err === "string") return { code: "command_error", message: err };
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      "message" in err
    )
      return err;
    return { code: "command_error", message: "Command failed." };
  }),
}));

// Import AFTER vi.mock so the mock is in place
import { useAppPersistence } from "./useAppPersistence";
import { loadConfig, saveConfig } from "../lib/backend";

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedSaveConfig = vi.mocked(saveConfig);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const baseConfig: AppConfig = makeConfig();

const altConfig: AppConfig = makeConfig({
  settings: {
    ...makeConfig().settings,
    theme: "light",
  },
});

const loadResponse: LoadConfigResponse = {
  config: baseConfig,
  warnings: [],
  path: "/test/config.json",
  createdDefault: false,
};

const saveResponse: SaveConfigResponse = {
  config: baseConfig,
  warnings: [],
  path: "/test/config.json",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the hook, call refreshConfig to get it into "ready" state, return result. */
async function renderReady() {
  mockedLoadConfig.mockResolvedValue(loadResponse);
  const { result } = renderHook(() => useAppPersistence());
  await act(async () => {
    await result.current.refreshConfig();
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAppPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedLoadConfig.mockReset();
    mockedSaveConfig.mockReset();
    // Default: saveConfig resolves immediately
    mockedSaveConfig.mockResolvedValue(saveResponse);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Config loading
  // =========================================================================
  describe("config loading", () => {
    it("initial viewState is 'idle'", () => {
      const { result } = renderHook(() => useAppPersistence());
      expect(result.current.viewState).toBe("idle");
    });

    it("refreshConfig sets viewState to 'loading' then 'ready' on success", async () => {
      mockedLoadConfig.mockResolvedValue(loadResponse);
      const { result } = renderHook(() => useAppPersistence());

      let promise: Promise<boolean>;
      act(() => {
        promise = result.current.refreshConfig();
      });
      // After calling but before awaiting, viewState should be "loading"
      expect(result.current.viewState).toBe("loading");

      await act(async () => {
        await promise!;
      });
      expect(result.current.viewState).toBe("ready");
    });

    it("refreshConfig sets viewState to 'error' on IPC failure", async () => {
      mockedLoadConfig.mockRejectedValue({
        code: "io_error",
        message: "File not found",
      });
      const { result } = renderHook(() => useAppPersistence());

      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.viewState).toBe("error");
    });

    it("refreshConfig returns true on success", async () => {
      mockedLoadConfig.mockResolvedValue(loadResponse);
      const { result } = renderHook(() => useAppPersistence());

      let success: boolean;
      await act(async () => {
        success = await result.current.refreshConfig();
      });
      expect(success!).toBe(true);
    });

    it("refreshConfig returns false on failure", async () => {
      mockedLoadConfig.mockRejectedValue("boom");
      const { result } = renderHook(() => useAppPersistence());

      let success: boolean;
      await act(async () => {
        success = await result.current.refreshConfig();
      });
      expect(success!).toBe(false);
    });

    it("refreshConfig sets workingConfig from IPC response", async () => {
      mockedLoadConfig.mockResolvedValue(loadResponse);
      const { result } = renderHook(() => useAppPersistence());

      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.workingConfig).toEqual(baseConfig);
    });

    it("refreshConfig cancels pending auto-save", async () => {
      const result = await renderReady();
      mockedSaveConfig.mockClear();

      // Trigger a draft update that schedules auto-save
      act(() => {
        result.current.updateDraft(() => altConfig);
      });

      // Now immediately call refreshConfig — this should cancel the pending save
      mockedLoadConfig.mockResolvedValue(loadResponse);
      await act(async () => {
        await result.current.refreshConfig();
      });

      // Advance time past the debounce — save should NOT fire
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      expect(mockedSaveConfig).not.toHaveBeenCalled();
    });

    it("refreshConfig sets error to null on start", async () => {
      // First: force an error state
      mockedLoadConfig.mockRejectedValue("fail");
      const { result } = renderHook(() => useAppPersistence());
      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.error).not.toBeNull();

      // Second: succeed — error should be cleared
      mockedLoadConfig.mockResolvedValue(loadResponse);
      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // Undo / Redo
  // =========================================================================
  describe("undo / redo", () => {
    it("updateDraft pushes current config to undoStack", async () => {
      const result = await renderReady();
      expect(result.current.undoStack).toHaveLength(0);

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      expect(result.current.undoStack).toHaveLength(1);
      expect(result.current.undoStack[0]).toEqual(baseConfig);
    });

    it("updateDraft clears redoStack", async () => {
      const result = await renderReady();

      // Create an undo entry then undo (which populates redoStack)
      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      act(() => {
        result.current.handleUndo();
      });
      expect(result.current.redoStack.length).toBeGreaterThan(0);

      // Now updateDraft should clear redoStack
      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      expect(result.current.redoStack).toHaveLength(0);
    });

    it("handleUndo pops from undoStack and restores previous config", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      expect(result.current.workingConfig).toEqual(altConfig);

      act(() => {
        result.current.handleUndo();
      });
      expect(result.current.workingConfig).toEqual(baseConfig);
      expect(result.current.undoStack).toHaveLength(0);
    });

    it("handleUndo pushes current config to redoStack", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      act(() => {
        result.current.handleUndo();
      });

      expect(result.current.redoStack).toHaveLength(1);
      expect(result.current.redoStack[0]).toEqual(altConfig);
    });

    it("handleUndo is no-op when undoStack is empty", async () => {
      const result = await renderReady();
      const configBefore = result.current.workingConfig;

      act(() => {
        result.current.handleUndo();
      });
      expect(result.current.workingConfig).toEqual(configBefore);
      expect(result.current.undoStack).toHaveLength(0);
    });

    it("handleRedo pops from redoStack and restores next config", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      act(() => {
        result.current.handleUndo();
      });
      expect(result.current.workingConfig).toEqual(baseConfig);

      act(() => {
        result.current.handleRedo();
      });
      expect(result.current.workingConfig).toEqual(altConfig);
      expect(result.current.redoStack).toHaveLength(0);
    });

    it("handleRedo pushes current config to undoStack", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      act(() => {
        result.current.handleUndo();
      });
      // undoStack is now empty, redoStack has altConfig
      expect(result.current.undoStack).toHaveLength(0);

      act(() => {
        result.current.handleRedo();
      });
      // undoStack should now have baseConfig (it was current before redo)
      expect(result.current.undoStack).toHaveLength(1);
      expect(result.current.undoStack[0]).toEqual(baseConfig);
    });

    it("handleRedo is no-op when redoStack is empty", async () => {
      const result = await renderReady();
      const configBefore = result.current.workingConfig;

      act(() => {
        result.current.handleRedo();
      });
      expect(result.current.workingConfig).toEqual(configBefore);
      expect(result.current.redoStack).toHaveLength(0);
    });

    it("undo stack is capped at MAX_UNDO (15) entries", async () => {
      const result = await renderReady();

      // Push 20 drafts — only 15 should remain
      for (let i = 0; i < 20; i++) {
        act(() => {
          result.current.updateDraft((c) => ({
            ...c,
            version: c.version + 1,
          }));
        });
      }
      expect(result.current.undoStack).toHaveLength(15);
    });

    it("undo/redo round-trip preserves config", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      act(() => {
        result.current.handleUndo();
      });
      act(() => {
        result.current.handleRedo();
      });
      expect(result.current.workingConfig).toEqual(altConfig);
    });
  });

  // =========================================================================
  // Auto-save
  // =========================================================================
  describe("auto-save", () => {
    it("updateDraft triggers save_config IPC after delay", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      // Not called yet — debounce pending
      expect(mockedSaveConfig).not.toHaveBeenCalled();

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(mockedSaveConfig).toHaveBeenCalledTimes(1);
      expect(mockedSaveConfig).toHaveBeenCalledWith(altConfig);
    });

    it("multiple rapid updateDraft calls debounce to single save", async () => {
      const result = await renderReady();

      const configs: AppConfig[] = [];
      for (let i = 1; i <= 5; i++) {
        const cfg = makeConfig({ version: i + 1 });
        configs.push(cfg);
        act(() => {
          result.current.updateDraft(() => cfg);
        });
      }

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Only the last config should have been saved
      expect(mockedSaveConfig).toHaveBeenCalledTimes(1);
      expect(mockedSaveConfig).toHaveBeenCalledWith(configs[configs.length - 1]);
    });

    it("handleUndo also triggers auto-save", async () => {
      const result = await renderReady();
      mockedSaveConfig.mockClear();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      // Flush the draft save
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      mockedSaveConfig.mockClear();

      act(() => {
        result.current.handleUndo();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(mockedSaveConfig).toHaveBeenCalledTimes(1);
      expect(mockedSaveConfig).toHaveBeenCalledWith(baseConfig);
    });

    it("handleRedo also triggers auto-save", async () => {
      const result = await renderReady();
      mockedSaveConfig.mockClear();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      mockedSaveConfig.mockClear();

      act(() => {
        result.current.handleUndo();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      mockedSaveConfig.mockClear();

      act(() => {
        result.current.handleRedo();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(mockedSaveConfig).toHaveBeenCalledTimes(1);
      expect(mockedSaveConfig).toHaveBeenCalledWith(altConfig);
    });

    it("successful auto-save sets viewState to 'ready'", async () => {
      const result = await renderReady();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.viewState).toBe("ready");
    });

    it("failed auto-save sets viewState to 'error'", async () => {
      const result = await renderReady();
      mockedSaveConfig.mockRejectedValue({
        code: "io_error",
        message: "Disk full",
      });

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.viewState).toBe("error");
    });

    it("auto-save calls onAutoSaved callback on success", async () => {
      const onAutoSaved = vi.fn();
      mockedLoadConfig.mockResolvedValue(loadResponse);
      mockedSaveConfig.mockResolvedValue(saveResponse);

      const { result } = renderHook(() => useAppPersistence(onAutoSaved));
      await act(async () => {
        await result.current.refreshConfig();
      });

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(onAutoSaved).toHaveBeenCalledTimes(1);
    });

    it("auto-save updates lastSave on success", async () => {
      const result = await renderReady();
      expect(result.current.lastSave).toBeNull();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.lastSave).toEqual(saveResponse);
    });
  });

  // =========================================================================
  // Derived values
  // =========================================================================
  describe("derived values", () => {
    it("activeConfig equals workingConfig", async () => {
      const result = await renderReady();
      expect(result.current.activeConfig).toBe(result.current.workingConfig);
    });

    it("activeConfig is null before loading", () => {
      const { result } = renderHook(() => useAppPersistence());
      expect(result.current.activeConfig).toBeNull();
    });

    it("activeWarnings comes from snapshot when no lastSave", async () => {
      const warnings = [
        { code: "w1", message: "test warning", severity: "warning" as const },
      ];
      mockedLoadConfig.mockResolvedValue({ ...loadResponse, warnings });
      const { result } = renderHook(() => useAppPersistence());

      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.activeWarnings).toEqual(warnings);
    });

    it("activeWarnings comes from lastSave when available", async () => {
      const snapshotWarnings = [
        { code: "w1", message: "old", severity: "warning" as const },
      ];
      const saveWarnings = [
        { code: "w2", message: "new", severity: "warning" as const },
      ];
      mockedLoadConfig.mockResolvedValue({
        ...loadResponse,
        warnings: snapshotWarnings,
      });
      mockedSaveConfig.mockResolvedValue({
        ...saveResponse,
        warnings: saveWarnings,
      });

      const { result } = renderHook(() => useAppPersistence());
      await act(async () => {
        await result.current.refreshConfig();
      });

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.activeWarnings).toEqual(saveWarnings);
    });

    it("activeWarnings is empty array when no snapshot or lastSave", () => {
      const { result } = renderHook(() => useAppPersistence());
      expect(result.current.activeWarnings).toEqual([]);
    });

    it("activePath comes from snapshot initially", async () => {
      const result = await renderReady();
      expect(result.current.activePath).toBe("/test/config.json");
    });

    it("activePath shows fallback before loading", () => {
      const { result } = renderHook(() => useAppPersistence());
      expect(result.current.activePath).toBe("Пока не загружен");
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe("error handling", () => {
    it("sets error on load failure", async () => {
      mockedLoadConfig.mockRejectedValue({
        code: "io_error",
        message: "Not found",
      });
      const { result } = renderHook(() => useAppPersistence());

      await act(async () => {
        await result.current.refreshConfig();
      });
      expect(result.current.error).toEqual({
        code: "io_error",
        message: "Not found",
      });
    });

    it("updateDraft clears error", async () => {
      // Load successfully, then set an error manually
      const result = await renderReady();
      act(() => {
        result.current.setError({ code: "test", message: "manual error" });
      });
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.updateDraft(() => altConfig);
      });
      expect(result.current.error).toBeNull();
    });
  });
});
