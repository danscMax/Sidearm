import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConfirmModalRequest } from "./components/ConfirmModal";
import { useAppPersistence } from "./hooks/useAppPersistence";
import { useLogPanel } from "./hooks/useLogPanel";
import { useRuntime } from "./hooks/useRuntime";
import { useVerification } from "./hooks/useVerification";
import { useActionPicker } from "./hooks/useActionPicker";
import { error as logError } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { ActionPickerModal } from "./components/ActionPickerModal";
import { CommandPalette, type RecentPaletteItem } from "./components/CommandPalette";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { ConfirmModal } from "./components/ConfirmModal";
import { DebugWorkspace } from "./components/DebugWorkspace";
import { ErrorModal } from "./components/ErrorModal";
import { PortableMigrationDialog } from "./components/PortableMigrationDialog";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { SynapseImportModal } from "./components/SynapseImportModal";
import { Toast, type ToastState } from "./components/Toast";
import { ProfilesWorkspace } from "./components/ProfilesWorkspace";
import { SettingsWorkspace, type SettingsDeepLink } from "./components/SettingsWorkspace";
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
  listenDragDrop,
  listenMouseDefaultsSuspected,
  listenSingleInstanceBlocked,
  listenTrayProfileChanged,
  listenQuickRuleStart,
  listenQuickRuleFailed,
  parseSynapseSource,
  restoreConfigFromBackup,
} from "./lib/backend";
import { displayNameForControl, labelForLayer, relativeTime } from "./lib/labels";
import type { ErrorActionKind } from "./lib/errors";
import type { ParsedSynapseProfiles } from "./lib/synapse-import";
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
  WindowCaptureResult,
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
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastSeqRef = useRef(0);
  const [synapseParsed, setSynapseParsed] = useState<ParsedSynapseProfiles | null>(null);
  const [settingsDeepLink, setSettingsDeepLink] = useState<SettingsDeepLink | null>(null);

  const showToast = useCallback((message: string, kind?: ToastState["kind"], action?: ToastState["action"]) => {
    toastSeqRef.current += 1;
    const next = { id: toastSeqRef.current, message, kind, action };
    setToasts((current) => [...current.slice(-2), next]);
  }, []);

  const handleAutoSaveFailed = useCallback(
    (reason: string) => {
      showToast(t("toast.saveFailedRollback", { reason }), "warning", { label: t("toast.openConfig"), onClick: () => { void openConfigFolder(); } });
    },
    [showToast, t],
  );

  const persistence = useAppPersistence(undefined, handleAutoSaveFailed, () =>
  showToast(t("toast.backupFailed"), "warning"),
);
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
    void listenDragDrop(async (paths) => {
      const path = paths[0];
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
    showToast(t("toast.undone"), "info", { label: t("toast.undoAction"), onClick: () => { handleRedoWithToast(); } });
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

  // Stable identity: effects/memos below depend on this (e.g. the quick-rule
  // listener). A plain function would change identity every render and make
  // those effects re-subscribe each time, leaking native event listeners.
  const switchWorkspaceMode = useCallback((nextMode: WorkspaceMode) => {
    startTransition(() => {
      setWorkspaceMode(nextMode);
    });
  }, []);

  // Single-instance: backend already focused this window; just inform the user
  // a duplicate launch was ignored. The Diagnostics log line comes from Rust.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenSingleInstanceBlocked(() => {
      showToast(t("instance.blocked"), "info");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showToast, t]);

  // Capture helper detected the mouse typing factory digits instead of the
  // configured keys (Razer profile not applied — Synapse down / onboard slot
  // reset). Also recorded as a warning in Diagnostics by the backend.
  // ponytail: toast only — a sticky banner needs a RuntimeStateSummary flag;
  // add one if users keep missing the toast while the window is closed.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenMouseDefaultsSuspected(() => {
      showToast(t("mouseDefaults.suspected"), "warning");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showToast, t]);

  // Tray switched the active profile — mirror the selection into the UI.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenTrayProfileChanged((profileId) => {
      setSelectedProfileId(profileId);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Tray "Create rule for active window" — switch to Profiles and open the
  // prefilled create-rule dialog.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenQuickRuleStart((capture) => {
      switchWorkspaceMode("profiles");
      setQuickRuleCapture(capture);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [switchWorkspaceMode]);

  // Tray quick-rule found no usable target window (only Sidearm was in front) —
  // tell the user instead of failing silently.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenQuickRuleFailed(() => {
      showToast(t("quickRule.failed"), "warning");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showToast, t]);

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
        } catch (unknownError) {
          setError(normalizeCommandError(unknownError));
        }
        return;
      }
      if (kind === "retry") {
        setError(null);
        await refreshConfig();
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
          if (!target) {
            setError({
              code: "backup_unavailable",
              message: t("backup.empty"),
            });
            return;
          }
          await restoreConfigFromBackup(target.path);
          setError(null);
          await refreshConfig();
        } catch (unknownError) {
          setError(normalizeCommandError(unknownError));
        }
      }
    },
    [refreshConfig, setError, t],
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
        await refreshConfig();
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
  const [confirmModal, setConfirmModal] = useState<ConfirmModalRequest | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // Cross-component "open the add-rule dialog" request from the command palette.
  // ProfilesWorkspace consumes it on mount/change and calls back to reset.
  const [addRuleSignal, setAddRuleSignal] = useState(false);
  // Tray "Create rule for active window" capture, consumed by ProfilesWorkspace.
  const [quickRuleCapture, setQuickRuleCapture] = useState<WindowCaptureResult | null>(null);


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

  // Auto-follow the runtime's resolved profile on window-focus change — but ONLY
  // on the Assignments view, where the intent is to show the active profile's
  // bindings as you edit. On Diagnostics/Settings a manual profile pick must
  // stick, so a capture event must not silently overwrite it (root cause of
  // "I switch the profile and nothing changes / it snaps back").
  // Also suppressed while a manual capture is in progress (countdown → capture → result).
  const [profileSyncSuppressed, setProfileSyncSuppressed] = useState(false);
  useEffect(() => {
    if (profileSyncSuppressed) return;
    if (workspaceMode !== "profiles") return;
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
  }, [lastCapture, profileSyncSuppressed, workspaceMode]);

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

    // Audit F008: while a modal/overlay is open, global shortcuts (undo/redo,
    // Ctrl+K, arrows, Enter→action picker, number tabs) must not fire "through"
    // it onto the background workspace. Only Escape is allowed past this gate —
    // the branch below routes it to close the topmost overlay.
    const anyModalOpen =
      commandPaletteOpen ||
      shortcutHelpOpen ||
      actionPickerOpen ||
      !!confirmModal ||
      showMigrationDialog ||
      showOnboarding ||
      !!synapseParsed ||
      viewState === "error";
    if (anyModalOpen && e.key !== "Escape") {
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
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "n") {
      // Ctrl+N: new profile (Ctrl+Alt+N is the OS-global show/hide toggle).
      e.preventDefault();
      executeCommand("new-profile");
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "A") {
      // Ctrl+Shift+A: add rule
      e.preventDefault();
      executeCommand("add-rule");
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "C") {
      // Ctrl+Shift+C: capture the active window
      e.preventDefault();
      executeCommand("capture-window");
    } else if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // "?" opens the keyboard-shortcut cheat-sheet.
      e.preventDefault();
      setShortcutHelpOpen(true);
    } else if (e.key === "Escape") {
      if (shortcutHelpOpen) {
        setShortcutHelpOpen(false);
      } else if (commandPaletteOpen) {
        setCommandPaletteOpen(false);
      } else if (actionPickerOpen) {
        setActionPickerOpen(false);
        setActionPickerBindingId(null);
      } else if (confirmModal) {
        setConfirmModal(null);
      } else if (viewState === "error") {
        // Escape dismisses the error modal (mirrors ErrorModal's onDismiss).
        // Without this it fell through to the else below, which left the modal
        // open AND cleared the background control selection as a side effect.
        setError(null);
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


  /** Single dispatch for command-palette commands, shared by the palette and
   *  the keyboard shortcuts in handleKeyDown (keeps the two in lockstep). */
  function executeCommand(commandId: string) {
    switch (commandId) {
      case "undo":
        handleUndoWithToast();
        break;
      case "redo":
        handleRedoWithToast();
        break;
      case "reload":
        void refreshConfig().catch((unknownError) => {
          setError(normalizeCommandError(unknownError));
        });
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
        void openConfigFolder().catch((unknownError) => {
          setError(normalizeCommandError(unknownError));
        });
        break;
      case "capture-window":
        void handleCaptureActiveWindow().catch((unknownError) => {
          setError(normalizeCommandError(unknownError));
        });
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
      case "shortcuts":
        setShortcutHelpOpen(true);
        break;
      case "toggle-runtime":
        if (runtimeSummary.status === "running") void handleStopRuntime();
        else void handleStartRuntime();
        break;
      case "open-snippet-library":
        switchWorkspaceMode("settings");
        setSettingsDeepLink({ tab: "snippets", nonce: Date.now() });
        break;
    }
  }

  function handleCreateProfile() {
    if (!workingConfig) return;
    const nextConfig = createProfile(workingConfig, t("profile.defaultName"));
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
  const profileNameById = useMemo(
    () => new Map<string, string>(activeConfig?.profiles.map((p) => [p.id, p.name]) ?? []),
    [activeConfig],
  );

  // Recent activity for the command palette's empty state: newest execution per
  // control (deduped), resolved into clickable navigation targets. The history
  // record carries no layer, so navigation lands on the control in the current
  // view (ponytail: layer-precise recall deferred).
  const recentPaletteItems = useMemo<RecentPaletteItem[]>(() => {
    const flat: Array<{ controlId: string; actionPretty: string; executedAt: number; profileName: string }> = [];
    for (const [controlId, records] of runtime.executionHistory) {
      for (const rec of records) {
        flat.push({ controlId, actionPretty: rec.actionPretty, executedAt: rec.executedAt, profileName: rec.profileName });
      }
    }
    flat.sort((a, b) => b.executedAt - a.executedAt);
    const seen = new Set<string>();
    const items: RecentPaletteItem[] = [];
    for (const entry of flat) {
      if (seen.has(entry.controlId)) continue;
      seen.add(entry.controlId);
      items.push({
        id: entry.controlId,
        label: entry.actionPretty,
        meta: `${entry.profileName} · ${relativeTime(entry.executedAt)}`,
        onSelect: () => {
          setCommandPaletteOpen(false);
          startTransition(() => setSelectedControlId(entry.controlId as ControlId));
          if (workspaceMode !== "profiles") switchWorkspaceMode("profiles");
        },
      });
      if (items.length >= 5) break;
    }
    return items;
  }, [runtime.executionHistory, workspaceMode, switchWorkspaceMode]);

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
    ? actionById.get(selectedBinding.actionId) ?? null
    : null;
  const selectedEncoder = selectedControl
    ? encoderByControlId.get(selectedControl.id) ?? null
    : null;
  function handleResetVerificationSession() {
    verification.handleResetVerificationSession((modal) => {
      setConfirmModal(modal);
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
                action: binding ? actionById.get(binding.actionId) ?? null : null,
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
    <TitleBar onReRunOnboarding={() => updateDraft((c) => ({ ...c, settings: { ...c.settings, onboardingCompleted: false } }))} />
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
        runtimeStatus={runtimeSummary.status}
        updateDraft={updateDraft}
        setSelectedProfileId={setSelectedProfileId}
        setConfirmModal={setConfirmModal}
        activeConfig={activeConfig}
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
                quickRuleCapture={quickRuleCapture}
                onQuickRuleHandled={() => setQuickRuleCapture(null)}
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
                executionHistory={runtime.executionHistory}
                throttledControlIds={runtime.throttledControlIds}
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
                deepLink={settingsDeepLink}
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
                  selectedControlHistory: selectedControl
                    ? runtime.executionHistory.get(selectedControl.id)
                    : undefined,
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
          controlLabel={selectedControl ? displayNameForControl(selectedControl, "raw") : undefined}
          layerLabel={labelForLayer(selectedLayer)}
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
          secondaryConfirmLabel={confirmModal.secondaryConfirmLabel}
          secondaryDanger={confirmModal.secondaryDanger}
          onSecondaryConfirm={confirmModal.onSecondaryConfirm}
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
      <Toast toast={toasts[0] ?? null} onDismiss={() => setToasts((current) => current.slice(1))} />

      {shortcutHelpOpen ? (
        <ShortcutHelp onClose={() => setShortcutHelpOpen(false)} />
      ) : null}

      {commandPaletteOpen ? (
        <CommandPalette
          onClose={() => setCommandPaletteOpen(false)}
          onExecute={(commandId) => {
            setCommandPaletteOpen(false);
            executeCommand(commandId);
          }}
          bindings={activeConfig?.bindings ?? []}
          actionsById={actionById}
          profileNameById={profileNameById}
          snippets={activeConfig?.snippetLibrary ?? []}
          recent={recentPaletteItems}
          onSelectBinding={(b) => {
            setCommandPaletteOpen(false);
            setSelectedProfileId(b.profileId);
            setSelectedLayer(b.layer);
            startTransition(() => setSelectedControlId(b.controlId));
            if (workspaceMode !== "profiles") switchWorkspaceMode("profiles");
          }}
          onSelectSnippet={(snippet) => {
            setCommandPaletteOpen(false);
            setSettingsDeepLink({
              tab: "snippets",
              snippetId: snippet.id,
              nonce: Date.now(),
            });
            switchWorkspaceMode("settings");
          }}
        />
      ) : null}

      {(() => {
        const running = runtimeSummary.status === "running";
        const totalEvents = [...runtime.executionCounts.values()].reduce((a, b) => a + b, 0);
        const lastApp = running && lastCapture?.exe
          ? lastCapture.exe.replace(/\.exe$/i, "")
          : null;
        const dotState = !running ? "off" : runtimeSummary.warningCount > 0 ? "warn" : "ok";
        return (
          <footer className="status-bar">
            <span className={`status-bar__dot status-bar__dot--${dotState}`} aria-hidden="true" />
            <span className="status-bar__text">
              {running ? t("sidebar.runtimeActive") : t("sidebar.runtimeStopped")}
              {running && totalEvents > 0 ? ` · ${t("statusbar.events", { count: totalEvents })}` : ""}
              {lastApp ? ` · ${lastApp}` : ""}
            </span>
            <button
              type="button"
              className="status-bar__toggle"
              title={t("sidebar.runtimeTooltip")}
              onClick={() => {
                if (running) void handleStopRuntime();
                else void handleStartRuntime();
              }}
            >
              {running ? t("sidebar.stop") : t("sidebar.start")}
            </button>
          </footer>
        );
      })()}
    </main>
    </>
  );
}

export default App;
