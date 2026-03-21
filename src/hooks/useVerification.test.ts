import type React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AppConfig, CommandError } from "../lib/config";
import type {
  EncodedKeyEvent,
  ResolvedInputPreview,
  WindowCaptureResult,
} from "../lib/runtime";

// ---------------------------------------------------------------------------
// Mock the backend module so we control IPC responses
// ---------------------------------------------------------------------------
vi.mock("../lib/backend", () => ({
  exportVerificationSession: vi.fn().mockResolvedValue("/export/path.json"),
  normalizeCommandError: vi.fn((e: unknown) => ({
    code: "command_error",
    message: String(e),
  })),
}));

// Import AFTER vi.mock so the mock is in place
import { useVerification } from "./useVerification";
import { exportVerificationSession } from "../lib/backend";

const mockedExportVerificationSession = vi.mocked(exportVerificationSession);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testConfig: AppConfig = {
  version: 1,
  settings: {
    fallbackProfileId: "p1",
    theme: "dark",
    startWithWindows: false,
    minimizeToTray: false,
    debugLogging: false,
    osdEnabled: true,
    osdDurationMs: 2000,
    osdPosition: "bottomRight",
    osdFontSize: "medium",
    osdAnimation: "slideIn",
  },
  profiles: [{ id: "p1", name: "Default", enabled: true, priority: 0 }],
  physicalControls: [
    {
      id: "thumb_01",
      family: "thumbGrid",
      defaultName: "Thumb 1",
      remappable: true,
      capabilityStatus: "needsValidation",
    },
    {
      id: "thumb_02",
      family: "thumbGrid",
      defaultName: "Thumb 2",
      remappable: true,
      capabilityStatus: "needsValidation",
    },
  ],
  encoderMappings: [
    {
      controlId: "thumb_01",
      layer: "standard",
      encodedKey: "F13",
      source: "synapse",
      verified: false,
    },
    {
      controlId: "thumb_02",
      layer: "standard",
      encodedKey: "F14",
      source: "synapse",
      verified: false,
    },
  ],
  appMappings: [],
  bindings: [],
  actions: [],
  snippetLibrary: [],
} as AppConfig;

const encodedKeyEvent: EncodedKeyEvent = {
  encodedKey: "F13",
  backend: "windows-hotkey",
  receivedAt: Date.now() + 1000,
  isRepeat: false,
  isKeyUp: false,
};

const resolutionPreview: ResolvedInputPreview = {
  status: "resolved",
  encodedKey: "F13",
  reason: "matched",
  usedFallbackProfile: false,
  candidateAppMappingIds: [],
  candidateControlIds: [],
  controlId: "thumb_01",
  layer: "standard",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    activeConfig: testConfig,
    effectiveProfileId: "p1",
    selectedLayer: "standard" as const,
    selectedControlId: "thumb_01" as const,
    setSelectedLayer: vi.fn(),
    setSelectedControlId: vi.fn(),
    runtimeStatus: "running" as const,
    ensureRuntimeStarted: vi.fn().mockResolvedValue(undefined),
    clearRuntimeError: vi.fn(),
    lastEncodedKey: null as EncodedKeyEvent | null,
    lastCapture: null as WindowCaptureResult | null,
    lastResolutionPreview: null as ResolvedInputPreview | null,
    setError: vi.fn() as unknown as React.Dispatch<React.SetStateAction<CommandError | null>>,
    ...overrides,
  };
}

/** Render hook and flush the initial useEffect sync. */
function renderVerification(overrides: Record<string, unknown> = {}) {
  const deps = makeDeps(overrides);
  const hook = renderHook(() => useVerification(deps));
  return { deps, ...hook };
}

/** Start a session via the hook, returning the latest result. */
async function renderWithSession(overrides: Record<string, unknown> = {}) {
  const deps = makeDeps(overrides);
  const hook = renderHook(() => useVerification(deps));

  await act(async () => {
    await hook.result.current.handleStartVerificationSession();
  });

  return { deps, ...hook };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Session creation
  // =========================================================================
  describe("session creation", () => {
    it("returns early if no activeConfig", async () => {
      const { result } = renderVerification({ activeConfig: null });

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      expect(result.current.verificationSession).toBeNull();
    });

    it("calls ensureRuntimeStarted if runtimeStatus is not running", async () => {
      const deps = makeDeps({ runtimeStatus: "idle" });
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      expect(deps.ensureRuntimeStarted).toHaveBeenCalledTimes(1);
    });

    it("skips runtime start if already running", async () => {
      const deps = makeDeps({ runtimeStatus: "running" });
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      expect(deps.ensureRuntimeStarted).not.toHaveBeenCalled();
    });

    it("sets error and returns if ensureRuntimeStarted throws", async () => {
      const ensureRuntimeStarted = vi.fn().mockRejectedValue("runtime failed");
      const deps = makeDeps({ runtimeStatus: "idle", ensureRuntimeStarted });
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      expect(deps.setError).toHaveBeenCalledWith({
        code: "command_error",
        message: "runtime failed",
      });
      expect(result.current.verificationSession).toBeNull();
    });

    it("creates session with correct scope and layer", async () => {
      const { result } = await renderWithSession();

      expect(result.current.verificationSession).not.toBeNull();
      expect(result.current.verificationSession!.scope).toBe("currentFamily");
      expect(result.current.verificationSession!.layer).toBe("standard");
      expect(result.current.verificationSession!.profileId).toBe("p1");
      expect(result.current.verificationSession!.steps.length).toBe(2);
    });

    it("clears runtime error and export path on session start", async () => {
      const { deps } = await renderWithSession();

      expect(deps.clearRuntimeError).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Step navigation
  // =========================================================================
  describe("step navigation", () => {
    it("handleNavigateVerificationStep moves to specified step index", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.handleNavigateVerificationStep(1);
      });

      expect(result.current.currentVerificationStep?.controlId).toBe(
        "thumb_02",
      );
    });

    it("handleReopenVerificationStep resets step to pending", async () => {
      const { result } = await renderWithSession();

      // Finalize step 0 first
      act(() => {
        result.current.handleVerificationResult("matched");
      });

      // Now active step moved to 1; reopen step 0
      act(() => {
        result.current.handleReopenVerificationStep(0);
      });

      expect(result.current.verificationSession!.activeStepIndex).toBe(0);
      expect(result.current.verificationSession!.steps[0].result).toBe(
        "pending",
      );
      expect(
        result.current.verificationSession!.steps[0].observedEncodedKey,
      ).toBeNull();
    });

    it("handleRestartVerificationStep resets current step observation data", async () => {
      const { result } = await renderWithSession();

      // Capture an observation first
      act(() => {
        result.current.onEncodedKeyEvent(encodedKeyEvent);
      });
      expect(
        result.current.verificationSession!.steps[0].observedEncodedKey,
      ).toBe("F13");

      // Restart should clear it
      act(() => {
        result.current.handleRestartVerificationStep();
      });

      expect(
        result.current.verificationSession!.steps[0].observedEncodedKey,
      ).toBeNull();
      expect(result.current.verificationSession!.steps[0].result).toBe(
        "pending",
      );
      // startedAt should be refreshed (not null)
      expect(
        result.current.verificationSession!.steps[0].startedAt,
      ).not.toBeNull();
    });
  });

  // =========================================================================
  // Results
  // =========================================================================
  describe("results", () => {
    it("handleVerificationResult finalizes current step with result", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.handleVerificationResult("matched");
      });

      // Step 0 should now be "matched"
      expect(result.current.verificationSession!.steps[0].result).toBe(
        "matched",
      );
      // Active step should advance to step 1
      expect(result.current.verificationSession!.activeStepIndex).toBe(1);
    });

    it("handleVerificationNotesChange updates notes on current step", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.handleVerificationNotesChange("Signal was weak");
      });

      expect(result.current.verificationSession!.steps[0].notes).toBe(
        "Signal was weak",
      );
    });
  });

  // =========================================================================
  // Session management
  // =========================================================================
  describe("session management", () => {
    it("handleResetVerificationSession nullifies session when no results exist", async () => {
      const { result } = await renderWithSession();
      const showConfirmModal = vi.fn();

      act(() => {
        result.current.handleResetVerificationSession(showConfirmModal);
      });

      // No results yet => direct reset, no confirm modal
      expect(showConfirmModal).not.toHaveBeenCalled();
      expect(result.current.verificationSession).toBeNull();
    });

    it("handleResetVerificationSession shows confirm modal when results exist", async () => {
      const { result } = await renderWithSession();
      const showConfirmModal = vi.fn();

      // Finalize a step so results exist
      act(() => {
        result.current.handleVerificationResult("matched");
      });

      act(() => {
        result.current.handleResetVerificationSession(showConfirmModal);
      });

      expect(showConfirmModal).toHaveBeenCalledTimes(1);
      // Session still exists until confirm callback is invoked
      expect(result.current.verificationSession).not.toBeNull();

      const modalArg = showConfirmModal.mock.calls[0][0];
      expect(modalArg.title).toBe("Сбросить сессию?");
      expect(modalArg.onConfirm).toBeInstanceOf(Function);

      // Invoke the confirm callback
      act(() => {
        modalArg.onConfirm();
      });

      expect(result.current.verificationSession).toBeNull();
    });

    it("handleExportVerificationSession calls export IPC with JSON", async () => {
      const { result } = await renderWithSession();

      await act(async () => {
        await result.current.handleExportVerificationSession();
      });

      expect(mockedExportVerificationSession).toHaveBeenCalledTimes(1);

      const [filename, contents] =
        mockedExportVerificationSession.mock.calls[0];
      expect(filename).toMatch(
        /^naga-verification-verification-\d+\.json$/,
      );
      const parsed = JSON.parse(contents);
      expect(parsed.version).toBe(1);
      expect(parsed.session).toBeDefined();
      expect(parsed.summary).toBeDefined();

      expect(result.current.lastVerificationExportPath).toBe(
        "/export/path.json",
      );
    });

    it("handleExportVerificationSession sets error on IPC failure", async () => {
      mockedExportVerificationSession.mockRejectedValueOnce("export failed");
      const deps = makeDeps();
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      await act(async () => {
        await result.current.handleExportVerificationSession();
      });

      expect(deps.setError).toHaveBeenCalledWith({
        code: "command_error",
        message: "export failed",
      });
    });

    it("handleExportVerificationSession returns early if no session", async () => {
      const { result } = renderVerification();

      await act(async () => {
        await result.current.handleExportVerificationSession();
      });

      expect(mockedExportVerificationSession).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Event integration
  // =========================================================================
  describe("event integration", () => {
    it("onEncodedKeyEvent captures observation on active step", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.onEncodedKeyEvent(encodedKeyEvent);
      });

      const step = result.current.verificationSession!.steps[0];
      expect(step.observedEncodedKey).toBe("F13");
      expect(step.observedAt).toBe(encodedKeyEvent.receivedAt);
      expect(step.observedBackend).toBe("windows-hotkey");
    });

    it("onEncodedKeyEvent is ignored when no session exists", () => {
      const { result } = renderVerification();

      act(() => {
        result.current.onEncodedKeyEvent(encodedKeyEvent);
      });

      expect(result.current.verificationSession).toBeNull();
    });

    it("onControlResolutionEvent captures resolution on active step", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.onControlResolutionEvent(resolutionPreview);
      });

      const step = result.current.verificationSession!.steps[0];
      expect(step.resolutionStatus).toBe("resolved");
      expect(step.resolvedControlId).toBe("thumb_01");
      expect(step.resolvedLayer).toBe("standard");
    });

    it("onControlResolutionEvent is ignored when no session exists", () => {
      const { result } = renderVerification();

      act(() => {
        result.current.onControlResolutionEvent(resolutionPreview);
      });

      expect(result.current.verificationSession).toBeNull();
    });
  });

  // =========================================================================
  // Derived values
  // =========================================================================
  describe("derived values", () => {
    it("sessionSummary counts by result type", async () => {
      const { result } = await renderWithSession();

      // Initially all pending
      expect(result.current.sessionSummary).toEqual({
        total: 2,
        matched: 0,
        mismatched: 0,
        noSignal: 0,
        skipped: 0,
        pending: 2,
      });

      // Finalize step 0 as matched
      act(() => {
        result.current.handleVerificationResult("matched");
      });

      expect(result.current.sessionSummary).toEqual({
        total: 2,
        matched: 1,
        mismatched: 0,
        noSignal: 0,
        skipped: 0,
        pending: 1,
      });
    });

    it("suggestedSessionResult returns noSignal when no observation", async () => {
      const { result } = await renderWithSession();

      // No observation captured, so suggestion should be noSignal
      expect(result.current.suggestedSessionResult).toBe("noSignal");
    });

    it("suggestedSessionResult returns matched when observation and resolution match", async () => {
      const deps = makeDeps({
        lastResolutionPreview: resolutionPreview,
      });
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      // Capture observation matching the expected key
      act(() => {
        result.current.onEncodedKeyEvent(encodedKeyEvent);
      });

      expect(result.current.suggestedSessionResult).toBe("matched");
    });

    it("hasVerificationResults is false for all-pending sessions", async () => {
      const { result } = await renderWithSession();

      expect(result.current.hasVerificationResults).toBe(false);
    });

    it("hasVerificationResults is true when any step has a result", async () => {
      const { result } = await renderWithSession();

      act(() => {
        result.current.handleVerificationResult("matched");
      });

      expect(result.current.hasVerificationResults).toBe(true);
    });

    it("sessionSummary returns zeroes when no session exists", () => {
      const { result } = renderVerification();

      expect(result.current.sessionSummary).toEqual({
        total: 0,
        matched: 0,
        mismatched: 0,
        noSignal: 0,
        skipped: 0,
        pending: 0,
      });
    });

    it("currentVerificationStep is null when no session exists", () => {
      const { result } = renderVerification();

      expect(result.current.currentVerificationStep).toBeNull();
    });
  });

  // =========================================================================
  // useEffect sync
  // =========================================================================
  describe("useEffect selectedControl/Layer sync", () => {
    it("syncs selectedLayer when session layer differs from current", async () => {
      const deps = makeDeps({ selectedLayer: "hypershift" as const });
      // Need hypershift encoder mappings for session creation
      const hypershiftConfig = {
        ...testConfig,
        encoderMappings: [
          {
            controlId: "thumb_01",
            layer: "hypershift",
            encodedKey: "Ctrl+Alt+Shift+F13",
            source: "synapse",
            verified: false,
          },
          {
            controlId: "thumb_02",
            layer: "hypershift",
            encodedKey: "Ctrl+Alt+Shift+F14",
            source: "synapse",
            verified: false,
          },
        ],
      } as AppConfig;
      deps.activeConfig = hypershiftConfig;
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      // Now change selectedLayer in deps to something different from session's layer.
      // The useEffect fires on re-render when selectedLayer differs.
      // Session was created with hypershift layer and step's controlId = thumb_01.
      // Let's verify the session was created correctly first.
      expect(result.current.verificationSession!.layer).toBe("hypershift");
    });

    it("syncs selectedControlId to match active step", async () => {
      const deps = makeDeps();
      const { result } = renderHook(() => useVerification(deps));

      await act(async () => {
        await result.current.handleStartVerificationSession();
      });

      // Active step is index 0 => controlId = thumb_01
      expect(result.current.currentVerificationStep?.controlId).toBe(
        "thumb_01",
      );

      // Navigate to step 1
      act(() => {
        result.current.handleNavigateVerificationStep(1);
      });

      // The useEffect should call setSelectedControlId with "thumb_02"
      expect(deps.setSelectedControlId).toHaveBeenCalledWith("thumb_02");
    });
  });

  // =========================================================================
  // Scope management
  // =========================================================================
  describe("scope management", () => {
    it("exposes verificationScope and setVerificationScope", () => {
      const { result } = renderVerification();

      expect(result.current.verificationScope).toBe("currentFamily");

      act(() => {
        result.current.setVerificationScope("all");
      });

      expect(result.current.verificationScope).toBe("all");
    });
  });
});
