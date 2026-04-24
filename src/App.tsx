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
import { error as logError } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { ActionPickerModal } from "./components/ActionPickerModal";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmModal } from "./components/ConfirmModal";
import { DebugWorkspace } from "./components/DebugWorkspace";
import { ErrorModal } from "./components/ErrorModal";
import { PortableMigrationDialog } from "./components/PortableMigrationDialog";
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
  const persistence = useAppPersistence();
  const {
    viewState,
    workingConfig,
    error, setError,
    undoStack,
    redoStack,
    activeConfig,
    refreshConfig, updateDraft, handleUndo, handleRedo,
  } = persistence;

  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeqRef = useRef(0);
  const [synapseParsed, setSynapseParsed] = useState<ParsedSynapseProfiles | null>(null);

  const showToast = useCallback((message: string, kind?: ToastState["kind"]) => {
    toastSeqRef.current += 1;
    setToast({ id: toastSeqRef.current, message, kind });
  }, []);

  // Tauri v2 file-drop event; looks like a hint the user wants to import a Synapse file.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const path = event.payload?.paths?.[0];
      if (typeof path !== "string") return;
      if (!path.toLowerCase().endsWith(".synapse4")) return;
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
    void getAppPaths().then((paths) => {
      if (!cancelled && paths.needsPortableMigrationPrompt) {
        setShowMigrationDialog(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        refreshConfig();
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
  const runtime = useRuntime({
    setError,
    onEncodedKeyEvent: (event: EncodedKeyEvent) => {
      verificationKeyEventRef.current?.(event);
    },
    onControlResolutionEvent: (preview) => {
      verificationResolutionRef.current?.(preview);
    },
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
    onConfirm: () => void;
  } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);


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
    updateDraft(() => nextConfig);
    if (nextProfile) {
      startTransition(() => {
        setSelectedProfileId(nextProfile.id);
      });
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
  const activeModeCopy = workspaceModeCopy.find((mode) => mode.value === workspaceMode)!;
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
        onSelectProfile={(id) => setSelectedProfileId(id)}
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
          heading={activeModeCopy.heading}
          undoCount={undoStack.length}
          redoCount={redoStack.length}
          viewState={viewState}
          onUndo={handleUndoWithToast}
          onRedo={handleRedoWithToast}
        />

        <div className="content__scroll">
        {activeConfig ? (
          <section className={workspaceClass}>
            {isProfilesMode ? (
              <ProfilesWorkspace
                activeConfig={activeConfig}
                activeProfile={activeProfile}
                effectiveProfileId={effectiveProfileId}
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
                setSelectedControlId={setSelectedControlId}
                setMultiSelectedControlIds={setMultiSelectedControlIds}
                setActionPickerBindingId={setActionPickerBindingId}
                setActionPickerOpen={setActionPickerOpen}
                executionCounts={runtime.executionCounts}
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
              <p className="panel__eyebrow">Ожидание конфигурации</p>
              <h2>Интерфейс ещё не загружен.</h2>
              <p>
                Как только конфигурация будет загружена, здесь появятся профили,
                карта мыши и редакторы.
              </p>
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
            updateDraft(() => nextConfig);
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
      {synapseParsed && activeConfig ? (
        <SynapseImportModal
          parsed={synapseParsed}
          activeConfig={activeConfig}
          onImported={(next, summary) => {
            updateDraft(() => next);
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
