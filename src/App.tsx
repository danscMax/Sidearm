import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppPersistence } from "./hooks/useAppPersistence";
import { useLogPanel } from "./hooks/useLogPanel";
import { useRuntime } from "./hooks/useRuntime";
import { useVerification } from "./hooks/useVerification";
import { useActionPicker } from "./hooks/useActionPicker";
import { error as logError } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { ActionPickerModal } from "./components/ActionPickerModal";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmModal } from "./components/ConfirmModal";
import { DebugWorkspace } from "./components/DebugWorkspace";
import { ErrorModal } from "./components/ErrorModal";
import { PortableMigrationDialog } from "./components/PortableMigrationDialog";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { SynapseImportModal } from "./components/SynapseImportModal";
import { Toast, type ToastState } from "./components/Toast";
import { ProfilesWorkspace } from "./components/ProfilesWorkspace";
import { SettingsWorkspace } from "./components/SettingsWorkspace";
import { ErrorPanel } from "./components/shared";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import {
  acceptPortableMigration,
  getAppPaths,
  listBackups,
  normalizeCommandError,
  openConfigFolder,
  parseSynapseSource,
  restoreConfigFromBackup,
} from "./lib/backend";
import type { ErrorActionKind } from "./lib/errors";
import type { ParsedSynapseProfiles } from "./lib/synapse-import";
import { listen } from "@tauri-apps/api/event";
import {
  createProfile,
  duplicateProfile,
  removeBinding,
} from "./lib/config-editing";
import type {
  Action,
  Binding,
  ControlId,
  EncoderMapping,
  Layer,
  SnippetLibraryItem,
} from "./lib/config";
import type {
  EncodedKeyEvent,
} from "./lib/runtime";
import {
  controlFamilyOrder,
  sideViewHotspots,
  topViewHotspots,
  workspaceModeCopy,
  type WorkspaceMode,
} from "./lib/constants";
import {
  resolveInitialControlId,
  resolveInitialProfileId,
} from "./lib/helpers";
import { useTranslation } from "react-i18next";

const ALL_HOTSPOT_IDS = [...Object.keys(sideViewHotspots), ...Object.keys(topViewHotspots)];

function App() {
  const { t } = useTranslation();

  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeqRef = useRef(0);
  const [synapseParsed, setSynapseParsed] = useState<ParsedSynapseProfiles | null>(null);

  const showToast = useCallback((message: string, kind?: ToastState["kind"]) => {
    toastSeqRef.current += 1;
    setToast({ id: toastSeqRef.current, message, kind });
  }, []);

  const handleAutoSaveFailed = useCallback(
    (reason: string) => {
      showToast(t("toast.saveFailedRollback", { reason }), "warning");
    },
    [showToast, t],
  );

  const persistence = useAppPersistence(undefined, handleAutoSaveFailed);
  const {
    viewState,
    workingConfig,
    error, setError,
    undoStack,
    redoStack,
    activeConfig,
    refreshConfig, updateDraft, handleUndo, handleRedo,
  } = persistence;

  // Tauri v2 file-drop event; looks like a hint the user wants to import a Synapse file.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const path = event.payload?.paths?.[0];
      if (typeof path !== "string") return;
      const lower = path.toLowerCase();
      if (!lower.endsWith(".synapse4") && !lower.endsWith(".synapse3")) return;
      try {
        const parsed = await parseSynapseSource(path);
        setSynapseParsed(parsed);
      } catch (unknownError) {
        setError(normalizeCommandError(unknownError));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [setError]);

  const handleUndoWithToast = useCallback(() => {
    if (undoStack.length === 0) return;
    handleUndo();
    showToast(t("toast.undone"), "info");
  }, [undoStack.length, handleUndo, showToast, t]);

  const handleRedoWithToast = useCallback(() => {
    if (redoStack.length === 0) return;
    handleRedo();
    showToast(t("toast.redone"), "info");
  }, [redoStack.length, handleRedo, showToast, t]);

  useEffect(() => {
    let cancelled = false;
    void getAppPaths()
      .then((paths) => {
        if (!cancelled && paths.needsPortableMigrationPrompt) {
          setShowMigrationDialog(true);
        }
      })
      .catch((error) => {
        console.error("getAppPaths failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // First-run onboarding: show the full-screen wizard until the user completes
  // or skips it (both set settings.onboardingCompleted = true).
  useEffect(() => {
    if (activeConfig && activeConfig.settings.onboardingCompleted !== true) {
      setShowOnboarding(true);
    }
  }, [activeConfig?.settings.onboardingCompleted]);

  const handleErrorAction = useCallback(
    async (kind: ErrorActionKind) => {
      if (kind === "openConfigFolder") {
        try {
          await openConfigFolder();
        } catch {
          // swallow — modal stays visible for the user
        }
        return;
      }
      if (kind === "retry") {
        setError(null);
        void refreshConfig();
        return;
      }
      if (kind === "openLastBackup") {
        try {
          const backups = await listBackups();
          const rolling1 = backups.find(
            (b) => b.kind.kind === "rolling" && b.kind.value === 1,
          );
          const lastKnownGood = backups.find(
            (b) => b.kind.kind === "lastKnownGood",
          );
          const target = rolling1 ?? lastKnownGood ?? backups[0];
          if (!target) return;
          await restoreConfigFromBackup(target.path);
          setError(null);
          refreshConfig();
        } catch {
          // swallow — modal stays visible for the user
        }
      }
    },
    [refreshConfig, setError],
  );

  const logPanel = useLogPanel();

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<Layer>("standard");
  const [selectedControlId, setSelectedControlId] = useState<ControlId | null>(null);
  const [multiSelectedControlIds, setMultiSelectedControlIds] = useState<Set<ControlId>>(new Set());

  const verificationKeyEventRef = useRef<((event: EncodedKeyEvent) => void) | null>(null);
  const verificationResolutionRef = useRef<((preview: import("./lib/runtime").ResolvedInputPreview) => void) | null>(null);
  const heatmapEnabledRef = useRef(false);
  const runtime = useRuntime({
    setError,
    onEncodedKeyEvent: (event: EncodedKeyEvent) => {
      verificationKeyEventRef.current?.(event);
    },
    onControlResolutionEvent: (preview) => {
      verificationResolutionRef.current?.(preview);
    },
    heatmapEnabledRef,
  });
  const {
    runtimeSummary, debugLog,
    captureDelayMs, setCaptureDelayMs,
    lastCapture, lastEncodedKey,
    resolutionKeyInput, setResolutionKeyInput,
    lastResolutionPreview, lastExecution, lastRuntimeError,
    handleStartRuntime, handleStopRuntime, handleReloadRuntime,
    handleCaptureActiveWindow, handlePreviewResolution,
    handleExecutePreviewAction, handleRunPreviewAction,
  } = runtime;

  const handleMigrationChoice = useCallback(
    async (copyFromRoaming: boolean) => {
      try {
        await acceptPortableMigration(copyFromRoaming);
        refreshConfig();
        // The capture runtime was started with the default-seed config that
        // load_config auto-created during startup, racing with our prompt.
        // After the migration overwrites config.json with the roaming copy
        // we must re-register hotkeys with the freshly-loaded config or the
        // first post-migration session silently has stale registrations.
        try {
          await handleReloadRuntime();
        } catch {
          // Runtime may not be running yet — ignore.
        }
      } catch (unknownError) {
        setError(normalizeCommandError(unknownError));
      } finally {
        setShowMigrationDialog(false);
      }
    },
    [refreshConfig, setError, handleReloadRuntime],
  );


  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("profiles");
  const [actionPickerOpen, setActionPickerOpen] = useState(false);
  const [actionPickerBindingId, setActionPickerBindingId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Cross-component "open the add-rule dialog" request from the command palette.
  // ProfilesWorkspace consumes it on mount/change and calls back to reset.
  const [addRuleSignal, setAddRuleSignal] = useState(false);


  useEffect(() => {
    async function initApp() {
      // Show the window now that React has mounted (avoids white flash).
      // The window starts hidden (visible:false in tauri.conf.json).
      void getCurrentWindow().show();

      const configLoaded = await refreshConfig();
      if (!configLoaded) return;
      try {
        await handleStartRuntime();
      } catch (unknownError) {
        console.warn("Runtime auto-start failed:", unknownError);
      }
    }
    void initApp();
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      void logError(
        `[ui] Unhandled: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      );
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      void logError(`[ui] Unhandled rejection: ${String(event.reason)}`);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    if (!activeConfig) {
      return;
    }

    if (
      selectedProfileId === null ||
      !activeConfig.profiles.some((profile) => profile.id === selectedProfileId)
    ) {
      startTransition(() => {
        setSelectedProfileId(resolveInitialProfileId(activeConfig));
      });
    }
  }, [activeConfig, selectedProfileId]);

  useEffect(() => {
    if (!activeConfig) {
      return;
    }

    if (
      selectedControlId === null ||
      !activeConfig.physicalControls.some((control) => control.id === selectedControlId)
    ) {
      startTransition(() => {
        setSelectedControlId(resolveInitialControlId(activeConfig));
      });
    }
  }, [activeConfig, selectedControlId]);

  // Sync UI profile with runtime's resolved profile (auto-switch on window focus change).
  // Suppressed while a manual capture is in progress (countdown → capture → result).
  const [profileSyncSuppressed, setProfileSyncSuppressed] = useState(false);
  useEffect(() => {
    if (profileSyncSuppressed) return;
    if (
      lastCapture &&
      !lastCapture.ignored &&
      lastCapture.resolvedProfileId &&
      lastCapture.resolvedProfileId !== selectedProfileId
    ) {
      startTransition(() => {
        setSelectedProfileId(lastCapture.resolvedProfileId!);
      });
    }
  }, [lastCapture, profileSyncSuppressed]);

  // H1: Global keyboard shortcuts (useEffectEvent avoids re-registering on every render)
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // Don't intercept when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      // Allow Escape to blur input
      if (e.key === "Escape") {
        (e.target as HTMLElement).blur();
        e.preventDefault();
      }
      return;
    }

    if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      handleUndoWithToast();
    } else if (e.ctrlKey && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
      e.preventDefault();
      handleRedoWithToast();
    } else if (e.ctrlKey && e.key === "k") {
      e.preventDefault();
      setCommandPaletteOpen((open) => !open);
    } else if (e.key === "Escape") {
      if (commandPaletteOpen) {
        setCommandPaletteOpen(false);
      } else if (actionPickerOpen) {
        setActionPickerOpen(false);
        setActionPickerBindingId(null);
      } else if (confirmModal) {
        setConfirmModal(null);
      } else {
        setSelectedControlId(null);
      }
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Arrow keys: navigate between hotspots
      if (ALL_HOTSPOT_IDS.length > 0 && selectedControlId) {
        e.preventDefault();
        const currentIndex = ALL_HOTSPOT_IDS.indexOf(selectedControlId);
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + ALL_HOTSPOT_IDS.length) % ALL_HOTSPOT_IDS.length;
        startTransition(() => {
          setSelectedControlId(ALL_HOTSPOT_IDS[nextIndex] as ControlId);
          setMultiSelectedControlIds(new Set());
        });
      }
    } else if (e.key === "Enter" && selectedControlId && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Enter: open the action picker for the selected control
      e.preventDefault();
      handleOpenActionPicker(selectedControlId, selectedBinding);
    } else if (
      (e.key === "Delete" || e.key === "Backspace") &&
      selectedControlId &&
      selectedBinding
    ) {
      // Delete/Backspace: clear the selected control's binding
      e.preventDefault();
      updateDraft((c) => removeBinding(c, selectedBinding.id));
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      // Number keys 1-4: switch workspace tabs
      const modeIndex = Number(e.key) - 1;
      if (modeIndex >= 0 && modeIndex < workspaceModeCopy.length) {
        switchWorkspaceMode(workspaceModeCopy[modeIndex].value);
      }
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function switchWorkspaceMode(nextMode: WorkspaceMode) {
    startTransition(() => { setWorkspaceMode(nextMode); });
  }

  function handleCreateProfile() {
    if (!workingConfig) return;
    const nextConfig = createProfile(workingConfig, "Новый профиль");
    const nextProfile = nextConfig.profiles.find(
      (profile) =>
        !workingConfig.profiles.some(
          (currentProfile) => currentProfile.id === profile.id,
        ),
    );
    updateDraft(() => nextConfig, { immediate: true });
    if (nextProfile) {
      startTransition(() => {
        setSelectedProfileId(nextProfile.id);
      });
    }
  }

  function handleDuplicateActiveProfile() {
    if (!effectiveProfileId) return;
    let newId: string | null = null;
    updateDraft((c) => {
      const result = duplicateProfile(c, effectiveProfileId);
      newId = result.newProfileId;
      return result.config;
    }, { immediate: true });
    if (newId) {
      startTransition(() => setSelectedProfileId(newId));
    }
  }

  const profiles = useMemo(
    () =>
      activeConfig
        ? [...activeConfig.profiles].sort(
            (left, right) =>
              right.priority - left.priority || (left.name ?? left.id).localeCompare(right.name ?? right.id),
          )
        : [],
    [activeConfig],
  );
  const effectiveProfileId =
    selectedProfileId ?? activeConfig?.settings.fallbackProfileId ?? null;

  // Keyboard-driven action picker (Enter on a selected control). Reuses the
  // same hook the visualization uses, so placeholder-binding creation stays DRY.
  const handleOpenActionPicker = useActionPicker({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  });

  const verification = useVerification({
    activeConfig,
    effectiveProfileId,
    selectedLayer,
    selectedControlId,
    setSelectedLayer,
    setSelectedControlId,
    runtimeStatus: runtime.runtimeSummary.status,
    ensureRuntimeStarted: runtime.ensureRuntimeStarted,
    clearRuntimeError: runtime.clearRuntimeError,
    lastEncodedKey: runtime.lastEncodedKey,
    lastCapture: runtime.lastCapture,
    lastResolutionPreview: runtime.lastResolutionPreview,
    setError: persistence.setError,
  });
  useEffect(() => {
    verificationKeyEventRef.current = verification.onEncodedKeyEvent;
    verificationResolutionRef.current = verification.onControlResolutionEvent;
  }, [verification.onEncodedKeyEvent, verification.onControlResolutionEvent]);

  const {
    verificationSession,
    verificationScope, setVerificationScope,
    lastVerificationExportPath,
    sessionSummary, currentVerificationStep, suggestedSessionResult, hasVerificationResults,
    handleStartVerificationSession, handleRestartVerificationStep,
    handleVerificationResult, handleVerificationNotesChange,
    handleNavigateVerificationStep, handleReopenVerificationStep,
    handleExportVerificationSession,
  } = verification;

  const activeProfile =
    profiles.find((profile) => profile.id === effectiveProfileId) ?? null;

  const actionById = useMemo(
    () =>
      new Map<string, Action>(
        activeConfig?.actions.map((action) => [action.id, action]) ?? [],
      ),
    [activeConfig],
  );
  const snippetById = useMemo(
    () =>
      new Map<string, SnippetLibraryItem>(
        activeConfig?.snippetLibrary.map((snippet) => [snippet.id, snippet]) ?? [],
      ),
    [activeConfig],
  );
  const bindingByControlId = useMemo(
    () =>
      new Map<ControlId, Binding>(
        activeConfig?.bindings
          .filter(
            (binding) =>
              binding.profileId === effectiveProfileId &&
              binding.layer === selectedLayer,
          )
          .map((binding) => [binding.controlId, binding]) ?? [],
      ),
    [activeConfig, effectiveProfileId, selectedLayer],
  );
  const encoderByControlId = useMemo(
    () =>
      new Map<ControlId, EncoderMapping>(
        activeConfig?.encoderMappings
          .filter((mapping) => mapping.layer === selectedLayer)
          .map((mapping) => [mapping.controlId, mapping]) ?? [],
      ),
    [activeConfig, selectedLayer],
  );

  const selectedControl =
    activeConfig?.physicalControls.find((control) => control.id === selectedControlId) ?? null;
  const selectedBinding =
    selectedControl ? bindingByControlId.get(selectedControl.id) ?? null : null;
  const selectedAction = selectedBinding
    ? actionById.get(selectedBinding.actionRef) ?? null
    : null;
  const selectedEncoder = selectedControl
    ? encoderByControlId.get(selectedControl.id) ?? null
    : null;
  function handleResetVerificationSession() {
    verification.handleResetVerificationSession((modal) => {
      setConfirmModal({
        ...modal,
        onConfirm: () => { modal.onConfirm(); setConfirmModal(null); },
      });
    });
  }

  const familySections = useMemo(
    () =>
      controlFamilyOrder.map((family) => ({
        family,
        entries:
          activeConfig?.physicalControls
            .filter((control) => control.family === family)
            .map((control) => {
              const binding = bindingByControlId.get(control.id) ?? null;
              return {
                control,
                binding,
                action: binding ? actionById.get(binding.actionRef) ?? null : null,
                mapping: encoderByControlId.get(control.id) ?? null,
                isSelected: control.id === selectedControlId,
              };
            }) ?? [],
      })),
    [activeConfig, bindingByControlId, actionById, encoderByControlId, selectedControlId],
  );

  const isProfilesMode = workspaceMode === "profiles";
  const activeModeHeading = t(`workspace.${workspaceMode}.heading`);
  const isDebugMode = workspaceMode === "debug";
  const workspaceClass = isDebugMode
    ? "workspace workspace--expert"
    : "workspace workspace--1col";

  return (
    <>
    <TitleBar />
    <main className="shell">
      <Sidebar
        workspaceMode={workspaceMode}
        onSwitchMode={switchWorkspaceMode}
        profiles={profiles}
        effectiveProfileId={effectiveProfileId}
        runtimeResolvedProfileName={lastCapture?.resolvedProfileName ?? null}
        onSelectProfile={(id) => {
          setSelectedProfileId(id);
          updateDraft((c) => ({
            ...c,
            settings: { ...c.settings, lastSelectedProfileId: id },
          }));
        }}
        onCreateProfile={handleCreateProfile}
        onToggleRuntime={() => {
          if (runtimeSummary.status === "running") void handleStopRuntime();
          else void handleStartRuntime();
        }}
        runtimeStatus={runtimeSummary.status}
        updateDraft={updateDraft}
        setSelectedProfileId={setSelectedProfileId}
        setConfirmModal={setConfirmModal}
      />

      <div className="content">
        <Toolbar
          heading={activeModeHeading}
          undoCount={undoStack.length}
          redoCount={redoStack.length}
          viewState={viewState}
          onUndo={handleUndoWithToast}
          onRedo={handleRedoWithToast}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />

        <div className="content__scroll">
        {activeConfig ? (
          <section className={workspaceClass}>
            {isProfilesMode ? (
              <ProfilesWorkspace
                activeConfig={activeConfig}
                activeProfile={activeProfile}
                effectiveProfileId={effectiveProfileId}
                addRuleSignal={addRuleSignal}
                onAddRuleHandled={() => setAddRuleSignal(false)}
                lastCapture={lastCapture}
                captureDelayMs={captureDelayMs}
                viewState={viewState}
                updateDraft={updateDraft}
                setCaptureDelayMs={setCaptureDelayMs}
                setConfirmModal={setConfirmModal}
                handleCaptureActiveWindow={handleCaptureActiveWindow}
                setProfileSyncSuppressed={setProfileSyncSuppressed}
                familySections={familySections}
                selectedLayer={selectedLayer}
                multiSelectedControlIds={multiSelectedControlIds}
                onSelectLayer={(layer) => setSelectedLayer(layer)}
                setSelectedProfileId={setSelectedProfileId}
                setSelectedControlId={setSelectedControlId}
                setMultiSelectedControlIds={setMultiSelectedControlIds}
                setActionPickerBindingId={setActionPickerBindingId}
                setActionPickerOpen={setActionPickerOpen}
                executionCounts={runtime.executionCounts}
                heatmapEnabledRef={heatmapEnabledRef}
                showToast={showToast}
              />
            ) : workspaceMode === "settings" ? (
              <SettingsWorkspace
                activeConfig={activeConfig}
                activeProfile={activeProfile}
                effectiveProfileId={effectiveProfileId}
                updateDraft={updateDraft}
                setSelectedProfileId={setSelectedProfileId}
                setConfirmModal={setConfirmModal}
                refreshConfig={refreshConfig}
                setError={setError}
                onRequestSynapseImport={setSynapseParsed}
                showToast={showToast}
              />
            ) : (
              <DebugWorkspace
                activeConfig={activeConfig}
                profiles={profiles}
                selectedControl={selectedControl}
                selectedBinding={selectedBinding}
                selectedAction={selectedAction}
                selectedEncoder={selectedEncoder}
                snippetById={snippetById}
                selectedLayer={selectedLayer}
                updateDraft={updateDraft}
                logPanel={logPanel}
                runtime={{
                  debugLog,
                  resolutionKeyInput,
                  setResolutionKeyInput,
                  lastResolutionPreview,
                  lastExecution,
                  lastRuntimeError,
                  lastEncodedKey,
                  runtimeSummary,
                  handlePreviewResolution,
                  handleExecutePreviewAction,
                  handleRunPreviewAction,
                }}
                verification={{
                  session: verificationSession,
                  scope: verificationScope,
                  setScope: setVerificationScope,
                  lastExportPath: lastVerificationExportPath,
                  sessionSummary,
                  currentStep: currentVerificationStep,
                  suggestedResult: suggestedSessionResult,
                  hasResults: hasVerificationResults,
                  handleStart: handleStartVerificationSession,
                  handleRestartStep: handleRestartVerificationStep,
                  handleResult: handleVerificationResult,
                  handleNotesChange: handleVerificationNotesChange,
                  handleNavigateStep: handleNavigateVerificationStep,
                  handleReopenStep: handleReopenVerificationStep,
                  handleReset: handleResetVerificationSession,
                  handleExport: handleExportVerificationSession,
                }}
              />
            )}
          </section>
        ) : (
          <section className="workspace workspace--1col">
            <section className="panel">
              <p className="panel__eyebrow">{t("configWaiting.eyebrow")}</p>
              <div className="loading-spinner" aria-hidden="true" />
              <h2>{t("configWaiting.heading")}</h2>
              <p>{t("configWaiting.body")}</p>
              {error ? <ErrorPanel error={error} /> : null}
            </section>
          </section>
        )}
        </div>
      </div>
      {actionPickerOpen && activeConfig ? (
        <ActionPickerModal
          config={activeConfig}
          bindingId={actionPickerBindingId}
          controlLabel={selectedControl?.defaultName}
          layerLabel={selectedLayer === "hypershift" ? "Hypershift" : "Стандартный"}
          controlId={selectedControlId ?? undefined}
          selectedLayer={selectedLayer}
          onSave={(nextConfig) => {
            // Explicit user commit from picker — bypass 500 ms debounce so
            // closing the modal (or any rapid follow-up action) cannot drop
            // the change before it reaches disk.
            updateDraft(() => nextConfig, { immediate: true });
            startTransition(() => {
              setActionPickerOpen(false);
              setActionPickerBindingId(null);
            });
          }}
          onCancel={() => {
            setActionPickerOpen(false);
            setActionPickerBindingId(null);
          }}
        />
      ) : null}
      {confirmModal ? (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      ) : null}
      <ErrorModal
        error={viewState === "error" ? error : null}
        onDismiss={() => setError(null)}
        onAction={handleErrorAction}
      />
      {showMigrationDialog ? (
        <PortableMigrationDialog onChoose={handleMigrationChoice} />
      ) : null}
      {showOnboarding && activeConfig && !showMigrationDialog ? (
        <OnboardingWizard
          config={activeConfig}
          applyConfig={(next) => updateDraft(() => next, { immediate: true })}
          onClose={() => setShowOnboarding(false)}
        />
      ) : null}
      {synapseParsed && activeConfig ? (
        <SynapseImportModal
          parsed={synapseParsed}
          activeConfig={activeConfig}
          onImported={(next, summary) => {
            updateDraft(() => next, { immediate: true });
            setSynapseParsed(null);
            showToast(
              t("synapseImport.summaryToast", {
                profiles: summary.profilesAdded,
                bindings: summary.bindingsAdded,
                actions: summary.actionsAdded,
                macros: summary.macrosAdded,
              }),
              "success",
            );
          }}
          onCancel={() => setSynapseParsed(null)}
          setError={setError}
        />
      ) : null}
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {commandPaletteOpen ? (
        <CommandPalette
          onClose={() => setCommandPaletteOpen(false)}
          onExecute={(commandId) => {
            setCommandPaletteOpen(false);
            switch (commandId) {
              case "undo":
                handleUndoWithToast();
                break;
              case "redo":
                handleRedoWithToast();
                break;
              case "reload":
                void refreshConfig();
                break;
              case "new-profile":
                handleCreateProfile();
                break;
              case "duplicate-profile":
                handleDuplicateActiveProfile();
                break;
              case "add-rule":
                switchWorkspaceMode("profiles");
                setAddRuleSignal(true);
                break;
              case "open-config-folder":
                void openConfigFolder();
                break;
              case "capture-window":
                void handleCaptureActiveWindow();
                break;
              case "tab-profiles":
                switchWorkspaceMode("profiles");
                break;
              case "tab-debug":
                switchWorkspaceMode("debug");
                break;
              case "tab-settings":
                switchWorkspaceMode("settings");
                break;
              case "layer-standard":
                setSelectedLayer("standard");
                break;
              case "layer-hypershift":
                setSelectedLayer("hypershift");
                break;
            }
          }}
        />
      ) : null}
    </main>
    </>
  );
}

export default App;
