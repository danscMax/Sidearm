import {
  startTransition,
  useEffect,
  useState,
} from "react";
import {
  exportVerificationSession,
  normalizeCommandError,
} from "../lib/backend";
import type {
  AppConfig,
  CommandError,
  ControlId,
  Layer,
} from "../lib/config";
import type {
  EncodedKeyEvent,
  ResolvedInputPreview,
  WindowCaptureResult,
} from "../lib/runtime";
import {
  activeVerificationStep,
  captureVerificationObservation,
  captureVerificationResolution,
  createVerificationSession,
  createVerificationSessionExport,
  finalizeVerificationStep,
  navigateToVerificationStep,
  reopenVerificationStep,
  restartVerificationStep,
  suggestedVerificationStepResult,
  summarizeVerificationSession,
  updateVerificationStepNotes,
  type VerificationSession,
  type VerificationSessionScope,
  type VerificationStepResult,
} from "../lib/verification-session";

export interface VerificationControl {
  // State
  verificationSession: VerificationSession | null;
  verificationScope: VerificationSessionScope;
  setVerificationScope: React.Dispatch<React.SetStateAction<VerificationSessionScope>>;
  lastVerificationExportPath: string | null;

  // Derived
  sessionSummary: ReturnType<typeof summarizeVerificationSession>;
  currentVerificationStep: ReturnType<typeof activeVerificationStep>;
  suggestedSessionResult: ReturnType<typeof suggestedVerificationStepResult>;
  hasVerificationResults: boolean;

  // Actions
  handleStartVerificationSession: () => Promise<void>;
  handleRestartVerificationStep: () => void;
  handleVerificationResult: (result: Exclude<VerificationStepResult, "pending">) => void;
  handleVerificationNotesChange: (notes: string) => void;
  handleNavigateVerificationStep: (stepIndex: number) => void;
  handleReopenVerificationStep: (stepIndex: number) => void;
  handleResetVerificationSession: (showConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  }) => void) => void;
  handleExportVerificationSession: () => Promise<void>;

  // Callbacks for runtime hook integration
  onEncodedKeyEvent: (event: EncodedKeyEvent) => void;
  onControlResolutionEvent: (preview: ResolvedInputPreview) => void;
}

export function useVerification(deps: {
  activeConfig: AppConfig | null;
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControlId: ControlId | null;
  setSelectedLayer: React.Dispatch<React.SetStateAction<Layer>>;
  setSelectedControlId: React.Dispatch<React.SetStateAction<ControlId | null>>;
  runtimeStatus: import("../lib/runtime").RuntimeStatus;
  ensureRuntimeStarted: () => Promise<void>;
  clearRuntimeError: () => void;
  lastEncodedKey: EncodedKeyEvent | null;
  lastCapture: WindowCaptureResult | null;
  lastResolutionPreview: ResolvedInputPreview | null;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
}): VerificationControl {
  const {
    activeConfig,
    effectiveProfileId,
    selectedLayer,
    selectedControlId,
    setSelectedLayer,
    setSelectedControlId,
    runtimeStatus,
    ensureRuntimeStarted,
    clearRuntimeError,
    lastEncodedKey,
    lastCapture,
    lastResolutionPreview,
    setError,
  } = deps;

  const [verificationSession, setVerificationSession] = useState<VerificationSession | null>(null);
  const [verificationScope, setVerificationScope] =
    useState<VerificationSessionScope>("currentFamily");
  const [lastVerificationExportPath, setLastVerificationExportPath] = useState<string | null>(null);

  // Sync selectedControlId/selectedLayer with the active verification step
  useEffect(() => {
    const activeStep = activeVerificationStep(verificationSession);
    if (!activeStep || !verificationSession || !activeConfig) {
      return;
    }

    // Guard: only sync if the step's control still exists in the config
    if (!activeConfig.physicalControls.some((c) => c.id === activeStep.controlId)) {
      return;
    }

    if (selectedLayer !== verificationSession.layer) {
      startTransition(() => {
        setSelectedLayer(verificationSession.layer);
      });
    }

    if (selectedControlId !== activeStep.controlId) {
      startTransition(() => {
        setSelectedControlId(activeStep.controlId);
      });
    }
  }, [selectedControlId, selectedLayer, verificationSession, activeConfig]);

  // --- Derived values ---

  const sessionSummary = summarizeVerificationSession(verificationSession);
  const currentVerificationStep = activeVerificationStep(verificationSession);
  const suggestedSessionResult = suggestedVerificationStepResult(
    currentVerificationStep,
    selectedControlId,
    selectedLayer,
    lastResolutionPreview,
  );
  const hasVerificationResults = verificationSession
    ? verificationSession.steps.some((step) => step.result !== "pending")
    : false;

  // --- Callback for runtime hook integration ---

  function onEncodedKeyEvent(event: EncodedKeyEvent) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? captureVerificationObservation(currentSession, event) : currentSession,
      );
    });
  }

  function onControlResolutionEvent(preview: ResolvedInputPreview) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? captureVerificationResolution(currentSession, preview) : currentSession,
      );
    });
  }

  // --- Action functions ---

  async function handleStartVerificationSession() {
    if (!activeConfig) {
      return;
    }

    if (runtimeStatus !== "running") {
      try {
        await ensureRuntimeStarted();
      } catch (unknownError) {
        startTransition(() => {
          setError(normalizeCommandError(unknownError));
        });
        return;
      }
    }

    const nextSession = createVerificationSession(
      activeConfig,
      selectedLayer,
      effectiveProfileId,
      selectedControlId,
      verificationScope,
    );

    if (!nextSession) {
      return;
    }

    startTransition(() => {
      setVerificationSession(nextSession);
      clearRuntimeError();
      setLastVerificationExportPath(null);
    });
  }

  function handleRestartVerificationStep() {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? restartVerificationStep(currentSession, Date.now()) : currentSession,
      );
    });
  }

  function handleVerificationResult(result: Exclude<VerificationStepResult, "pending">) {
    // Capture these from closure once — they are separate state atoms unlikely to be stale
    const capturedLastEncodedKey = lastEncodedKey;
    const capturedLastCapture = lastCapture;
    const capturedLastPreview = lastResolutionPreview;

    startTransition(() => {
      setVerificationSession((currentSession) => {
        if (!currentSession) return currentSession;
        const freshStep = activeVerificationStep(currentSession);
        const captureForStep =
          freshStep?.observedAt &&
          capturedLastEncodedKey?.receivedAt === freshStep.observedAt
            ? capturedLastCapture
            : null;
        const previewForStep =
          freshStep?.observedAt &&
          capturedLastEncodedKey?.receivedAt === freshStep.observedAt
            ? capturedLastPreview
            : null;
        return finalizeVerificationStep(
          currentSession,
          result,
          captureForStep,
          previewForStep,
          freshStep?.notes,
        );
      });
    });
  }

  function handleVerificationNotesChange(notes: string) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? updateVerificationStepNotes(currentSession, notes) : currentSession,
      );
    });
  }

  function handleNavigateVerificationStep(stepIndex: number) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? navigateToVerificationStep(currentSession, stepIndex) : currentSession,
      );
    });
  }

  function handleReopenVerificationStep(stepIndex: number) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? reopenVerificationStep(currentSession, stepIndex) : currentSession,
      );
    });
  }

  function handleResetVerificationSession(showConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  }) => void) {
    const hasResults = verificationSession?.steps.some((s) => s.result !== "pending") ?? false;
    if (hasResults) {
      showConfirmModal({
        title: "Сбросить сессию?",
        message: "Все результаты проверки будут потеряны.",
        confirmLabel: "Сбросить",
        onConfirm: () => {
          startTransition(() => {
            setVerificationSession(null);
            setLastVerificationExportPath(null);
          });
        },
      });
      return;
    }
    startTransition(() => {
      setVerificationSession(null);
      setLastVerificationExportPath(null);
    });
  }

  async function handleExportVerificationSession() {
    if (!verificationSession) {
      return;
    }

    try {
      const filename = `naga-verification-${verificationSession.sessionId}.json`;
      const report = createVerificationSessionExport(verificationSession);
      const writtenPath = await exportVerificationSession(
        filename,
        JSON.stringify(report, null, 2),
      );

      startTransition(() => {
        setError(null);
        clearRuntimeError();
        setLastVerificationExportPath(writtenPath);
      });
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  return {
    verificationSession,
    verificationScope,
    setVerificationScope,
    lastVerificationExportPath,
    sessionSummary,
    currentVerificationStep,
    suggestedSessionResult,
    hasVerificationResults,
    handleStartVerificationSession,
    handleRestartVerificationStep,
    handleVerificationResult,
    handleVerificationNotesChange,
    handleNavigateVerificationStep,
    handleReopenVerificationStep,
    handleResetVerificationSession,
    handleExportVerificationSession,
    onEncodedKeyEvent,
    onControlResolutionEvent,
  };
}
