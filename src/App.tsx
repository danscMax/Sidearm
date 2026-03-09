import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";

import "./App.css";
import {
  captureActiveWindow,
  executePreviewAction,
  exportVerificationSession,
  getDebugLog,
  listenActionExecutionEvent,
  listenControlResolutionEvent,
  listenEncodedKeyEvent,
  listenRuntimeErrorEvent,
  listenRuntimeEvent,
  listenWindowResolutionEvent,
  loadConfig,
  normalizeCommandError,
  previewResolution,
  reloadRuntime,
  runPreviewAction,
  saveConfig,
  startRuntime,
  stopRuntime,
} from "./lib/backend";
import {
  coerceActionType,
  createProfile,
  createDefaultActionMenuItem,
  createAppMappingFromCapture,
  createDefaultSubmenuItem,
  ensureEncoderMapping,
  ensurePlaceholderBinding,
  expectedEncodedKeyForControl,
  findBinding,
  promoteInlineSnippetActionToLibrary,
  seedExpectedEncoderMapping,
  updateControlCapabilityStatus,
  upsertAppMapping,
  upsertAction,
  upsertBinding,
  upsertEncoderMapping,
  upsertProfile,
  upsertSnippetLibraryItem,
} from "./lib/config-editing";
import {
  activeVerificationStep,
  captureVerificationObservation,
  createVerificationSession,
  createVerificationSessionExport,
  finalizeVerificationStep,
  restartVerificationStep,
  summarizeVerificationSession,
  type VerificationSession,
  type VerificationSessionScope,
  type VerificationStepResult,
  updateVerificationStepNotes,
} from "./lib/verification-session";
import type {
  Action,
  ActionType,
  AppConfig,
  AppMapping,
  Binding,
  CapabilityStatus,
  CommandError,
  ControlFamily,
  ControlId,
  EncoderMapping,
  Layer,
  LaunchActionPayload,
  LoadConfigResponse,
  MenuActionPayload,
  MenuItem,
  PasteMode,
  PhysicalControl,
  SaveConfigResponse,
  SequenceActionPayload,
  SequenceStep,
  ShortcutActionPayload,
  SnippetLibraryItem,
  TextSnippetPayload,
  ValidationWarning,
} from "./lib/config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  EncodedKeyEvent,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  RuntimeStateSummary,
  WindowCaptureResult,
} from "./lib/runtime";
import { idleRuntimeStateSummary } from "./lib/runtime";

type ViewState = "idle" | "loading" | "ready" | "saving" | "error";
type WorkspaceMode = "buttons" | "profiles" | "verification" | "advanced";

const controlFamilyOrder: ControlFamily[] = ["thumbGrid", "topPanel", "wheel", "system"];
const workspaceModeCopy: Array<{
  value: WorkspaceMode;
  label: string;
  body: string;
  heading: string;
  meta: string;
}> = [
  {
    value: "buttons",
    label: "Назначения",
    heading: "Назначения кнопок",
    body: "Главный рабочий экран: выберите кнопку мыши и быстро поменяйте её действие.",
    meta: "Быстрое назначение",
  },
  {
    value: "profiles",
    label: "Профили",
    heading: "Профили и автопереключение",
    body: "Настройка профилей, приоритетов и правил для конкретных приложений и окон.",
    meta: "Маршрутизация профилей",
  },
  {
    value: "verification",
    label: "Проверка",
    heading: "Проверка на реальной мыши",
    body: "Пошаговая сессия проверки: ожидалось, наблюдалось и что нужно исправить.",
    meta: "Живая валидация",
  },
  {
    value: "advanced",
    label: "Эксперт",
    heading: "Экспертный режим",
    body: "Сложные действия, библиотека фрагментов, журнал, диагностика и служебные инструменты.",
    meta: "Служебные инструменты",
  },
];

const verificationScopeCopy: Array<{
  value: VerificationSessionScope;
  label: string;
  body: string;
}> = [
  {
    value: "currentFamily",
    label: "Текущая группа",
    body: "Только кнопки из выбранной группы: боковая клавиатура, верхняя панель, колесо или системные контролы.",
  },
  {
    value: "all",
    label: "Весь слой",
    body: "Все контролы текущего слоя по очереди.",
  },
];


/** Hotspot positions for the TOP-DOWN photo (naga-top.jpg).
 *  Measured via hotspot-test.html click calibration. */
const topViewHotspots: Record<string, { left: number; top: number; label: string; size?: "sm" | "lg" }> = {
  mouse_left:        { left: 26, top: 10, label: "L" },
  wheel_up:          { left: 45.5, top: 13.5, label: "▲", size: "sm" },
  wheel_click:       { left: 45.5, top: 22.5, label: "●", size: "sm" },
  wheel_down:        { left: 45.5, top: 31.5, label: "▼", size: "sm" },
  hypershift_button: { left: 66, top: 10, label: "HS", size: "sm" },
  top_aux_01:        { left: 10, top: 11, label: "DPI+", size: "sm" },
  top_aux_02:        { left: 10, top: 21, label: "DPI−", size: "sm" },
  mouse_4:           { left: 32, top: 22.5, label: "M4", size: "sm" },
  mouse_5:           { left: 59.5, top: 23, label: "M5", size: "sm" },
};

/** Hotspot positions for the SIDE photo (naga-side.png).
 *  Layout: 4 columns × 3 rows. Each column counts bottom-to-top (1→2→3).
 *  Columns go left-to-right (front-to-back of mouse). */
const sideViewHotspots: Record<string, { left: number; top: number; label: string; size?: "sm" | "lg" }> = {
  thumb_01: { left: 44.5, top: 76, label: "1" },
  thumb_02: { left: 42.5, top: 56, label: "2" },
  thumb_03: { left: 41, top: 36.5, label: "3" },
  thumb_04: { left: 51.5, top: 73, label: "4" },
  thumb_05: { left: 50, top: 53.5, label: "5" },
  thumb_06: { left: 48.5, top: 33.5, label: "6" },
  thumb_07: { left: 59, top: 71, label: "7" },
  thumb_08: { left: 57, top: 51, label: "8" },
  thumb_09: { left: 55.5, top: 31.5, label: "9" },
  thumb_10: { left: 66, top: 68.5, label: "10" },
  thumb_11: { left: 64, top: 49, label: "11" },
  thumb_12: { left: 62.5, top: 29, label: "12" },
};

const layerCopy: Array<{ value: Layer; label: string; body: string }> = [
  {
    value: "standard",
    label: "Стандартный",
    body: "Основной слой назначений и сигналов.",
  },
  {
    value: "hypershift",
    label: "Hypershift",
    body: "Второй слой со своими биндами и отдельной валидацией.",
  },
];

const editableActionTypes: Array<{
  value: ActionType;
  label: string;
}> = [
  { value: "shortcut", label: "Шорткат" },
  { value: "textSnippet", label: "Текстовый фрагмент" },
  { value: "sequence", label: "Последовательность" },
  { value: "launch", label: "Запуск" },
  { value: "menu", label: "Меню" },
  { value: "disabled", label: "Отключено" },
];

type ControlSurfaceEntry = {
  control: PhysicalControl;
  binding: Binding | null;
  action: Action | null;
  mapping: EncoderMapping | null;
  isSelected: boolean;
};

function App() {
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [snapshot, setSnapshot] = useState<LoadConfigResponse | null>(null);
  const [workingConfig, setWorkingConfig] = useState<AppConfig | null>(null);
  const [lastSave, setLastSave] = useState<SaveConfigResponse | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<Layer>("standard");
  const [selectedControlId, setSelectedControlId] = useState<ControlId | null>(null);
  const [actionQuery, setActionQuery] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeStateSummary>(
    idleRuntimeStateSummary,
  );
  const [debugLog, setDebugLog] = useState<DebugLogEntry[]>([]);
  const [captureDelayMs, setCaptureDelayMs] = useState(1500);
  const [lastCapture, setLastCapture] = useState<WindowCaptureResult | null>(null);
  const [selectedAppMappingId, setSelectedAppMappingId] = useState<string | null>(null);
  const [resolutionKeyInput, setResolutionKeyInput] = useState("F13");
  const [lastResolutionPreview, setLastResolutionPreview] =
    useState<ResolvedInputPreview | null>(null);
  const [lastExecution, setLastExecution] = useState<ActionExecutionEvent | null>(null);
  const [lastRuntimeError, setLastRuntimeError] = useState<RuntimeErrorEvent | null>(null);
  const [lastEncodedKey, setLastEncodedKey] = useState<EncodedKeyEvent | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("buttons");
  const [verificationSession, setVerificationSession] = useState<VerificationSession | null>(null);
  const [verificationScope, setVerificationScope] =
    useState<VerificationSessionScope>("currentFamily");
  const [lastVerificationExportPath, setLastVerificationExportPath] = useState<string | null>(null);

  const deferredActionQuery = useDeferredValue(actionQuery);

  useEffect(() => {
    void refreshConfig();
  }, []);

  const activeWarnings = lastSave?.warnings ?? snapshot?.warnings ?? [];
  const activePath = lastSave?.path ?? snapshot?.path ?? "Пока не загружен";
  const activeConfig = workingConfig;

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

  useEffect(() => {
    setActionQuery("");
  }, [selectedProfileId, selectedLayer, selectedControlId]);

  useEffect(() => {
    const activeStep = activeVerificationStep(verificationSession);
    if (!activeStep || !verificationSession) {
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
  }, [selectedControlId, selectedLayer, verificationSession]);

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
      setVerificationSession((currentSession) =>
        currentSession ? captureVerificationObservation(currentSession, event) : currentSession,
      );
    });
    void refreshDebugLog();
  });

  const handleControlResolutionEvent = useEffectEvent((result: ResolvedInputPreview) => {
    startTransition(() => {
      setLastResolutionPreview(result);
    });
    void refreshDebugLog();
  });

  const handleActionExecutionEvent = useEffectEvent((event: ActionExecutionEvent) => {
    startTransition(() => {
      setLastExecution(event);
      setLastRuntimeError(null);
    });
    void refreshDebugLog();
  });

  const handleRuntimeErrorEvent = useEffectEvent((event: RuntimeErrorEvent) => {
    startTransition(() => {
      setLastRuntimeError(event);
    });
    void refreshDebugLog();
  });

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

    void attachRuntimeListeners();

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => {
        void unlisten();
      });
    };
  }, []);

  async function refreshDebugLog() {
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
  }

  async function refreshConfig() {
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
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
        setViewState("error");
      });
    }
  }

  async function persistConfig(config: AppConfig) {
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
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
        setViewState("error");
      });
    }
  }

  function updateDraft(updateConfig: (config: AppConfig) => AppConfig) {
    setWorkingConfig((currentConfig) => {
      if (!currentConfig) {
        return currentConfig;
      }

      return updateConfig(currentConfig);
    });
    setError(null);
    setIsDirty(true);
    setViewState("ready");
  }

  function resetDraft() {
    if (!snapshot) {
      return;
    }

    setWorkingConfig(snapshot.config);
    setError(null);
    setIsDirty(false);
    setViewState("ready");
  }

  function handleCreateProfile() {
    setWorkingConfig((currentConfig) => {
      if (!currentConfig) {
        return currentConfig;
      }

      const nextConfig = createProfile(currentConfig, "Новый профиль");
      const nextProfile = nextConfig.profiles.find(
        (profile) =>
          !currentConfig.profiles.some(
            (currentProfile) => currentProfile.id === profile.id,
          ),
      );
      if (nextProfile) {
        startTransition(() => {
          setSelectedProfileId(nextProfile.id);
        });
      }

      return nextConfig;
    });
    setError(null);
    setIsDirty(true);
    setViewState("ready");
  }

  function updateSelectedActionDraft(updateAction: (action: Action) => Action) {
    if (!selectedAction) {
      return;
    }

    updateDraft((config) => upsertAction(config, updateAction(selectedAction)));
  }

  async function handleStartRuntime() {
    try {
      const summary = await startRuntime();
      startTransition(() => {
        setRuntimeSummary(summary);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleReloadRuntime() {
    try {
      const summary = await reloadRuntime();
      startTransition(() => {
        setRuntimeSummary(summary);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleStopRuntime() {
    try {
      const summary = await stopRuntime();
      startTransition(() => {
        setRuntimeSummary(summary);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleCaptureActiveWindow() {
    try {
      const result = await captureActiveWindow(captureDelayMs);
      startTransition(() => {
        setLastCapture(result);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handlePreviewResolution() {
    try {
      const result = await previewResolution(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      );
      startTransition(() => {
        setLastResolutionPreview(result);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleExecutePreviewAction() {
    try {
      const result = await executePreviewAction(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      );
      startTransition(() => {
        setLastExecution(result);
        setLastRuntimeError(null);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  async function handleRunPreviewAction() {
    try {
      const result = await runPreviewAction(
        resolutionKeyInput,
        lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
        lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
      );
      startTransition(() => {
        setLastExecution(result);
        setLastRuntimeError(null);
      });
      await refreshDebugLog();
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  function updateSelectedSnippetDraft(
    updateSnippet: (snippet: SnippetLibraryItem) => SnippetLibraryItem,
  ) {
    if (!selectedSnippet) {
      return;
    }

    updateDraft((config) =>
      upsertSnippetLibraryItem(config, updateSnippet(selectedSnippet)),
    );
  }

  const profiles = activeConfig
    ? [...activeConfig.profiles].sort(
        (left, right) =>
          right.priority - left.priority || left.name.localeCompare(right.name),
      )
    : [];
  const effectiveProfileId =
    selectedProfileId ?? activeConfig?.settings.fallbackProfileId ?? null;
  const activeProfile =
    profiles.find((profile) => profile.id === effectiveProfileId) ?? null;

  const actionById = new Map<string, Action>(
    activeConfig?.actions.map((action) => [action.id, action]) ?? [],
  );
  const snippetById = new Map<string, SnippetLibraryItem>(
    activeConfig?.snippetLibrary.map((snippet) => [snippet.id, snippet]) ?? [],
  );
  const bindingByControlId = new Map<ControlId, Binding>(
    activeConfig?.bindings
      .filter(
        (binding) =>
          binding.profileId === effectiveProfileId &&
          binding.layer === selectedLayer,
      )
      .map((binding) => [binding.controlId, binding]) ?? [],
  );
  const encoderByControlId = new Map<ControlId, EncoderMapping>(
    activeConfig?.encoderMappings
      .filter((mapping) => mapping.layer === selectedLayer)
      .map((mapping) => [mapping.controlId, mapping]) ?? [],
  );

  const selectedControl =
    activeConfig?.physicalControls.find((control) => control.id === selectedControlId) ?? null;
  const selectedBinding =
    activeConfig && selectedControl && effectiveProfileId
      ? findBinding(
          activeConfig,
          effectiveProfileId,
          selectedLayer,
          selectedControl.id,
        )
      : null;
  const selectedAction = selectedBinding
    ? actionById.get(selectedBinding.actionRef) ?? null
    : null;
  const selectedSnippet =
    selectedAction &&
    selectedAction.type === "textSnippet" &&
    "source" in selectedAction.payload &&
    selectedAction.payload.source === "libraryRef"
      ? snippetById.get(selectedAction.payload.snippetId) ?? null
      : null;
  const selectedEncoder = selectedControl
    ? encoderByControlId.get(selectedControl.id) ?? null
    : null;
  const expectedEncodedKey = selectedControl
    ? expectedEncodedKeyForControl(selectedControl.id, selectedLayer)
    : null;
  const lastObservedEncodedKey = lastEncodedKey?.encodedKey ?? null;
  const lastObservedResolvedSelectedControl = Boolean(
    selectedControl &&
      lastResolutionPreview?.controlId === selectedControl.id &&
      lastResolutionPreview?.layer === selectedLayer &&
      lastEncodedKey,
  );
  const verificationAlignment = describeVerificationAlignment(
    expectedEncodedKey,
    selectedEncoder?.encodedKey ?? null,
    lastObservedEncodedKey,
    lastObservedResolvedSelectedControl,
  );
  const selectedAppMappings =
    activeConfig && effectiveProfileId
      ? sortAppMappings(
          activeConfig.appMappings.filter(
            (mapping) => mapping.profileId === effectiveProfileId,
          ),
        )
      : [];
  const selectedAppMapping =
    selectedAppMappings.find((mapping) => mapping.id === selectedAppMappingId) ?? null;
  const availableActions = getVisibleActions(
    activeConfig?.actions ?? [],
    deferredActionQuery,
    selectedBinding?.actionRef ?? null,
  );
  const selectedActionUsageCount =
    activeConfig && selectedBinding
      ? activeConfig.bindings.filter(
          (binding) => binding.actionRef === selectedBinding.actionRef,
        ).length
      : 0;
  const selectedSnippetUsageCount =
    activeConfig && selectedSnippet
      ? activeConfig.actions.filter(
          (action) =>
            action.type === "textSnippet" &&
            "source" in action.payload &&
            action.payload.source === "libraryRef" &&
            action.payload.snippetId === selectedSnippet.id,
        ).length
      : 0;
  const selectedSequencePayload =
    selectedAction &&
    selectedAction.type === "sequence" &&
    "steps" in selectedAction.payload
      ? (selectedAction.payload as SequenceActionPayload)
      : null;
  const selectedMenuPayload =
    selectedAction &&
    selectedAction.type === "menu" &&
    "items" in selectedAction.payload
      ? (selectedAction.payload as MenuActionPayload)
      : null;
  const menuActionOptions =
    selectedAction && activeConfig
      ? activeConfig.actions.filter((action) => action.id !== selectedAction.id)
      : [];
  const resolvedLiveRunnable =
    activeConfig && lastResolutionPreview?.actionId
      ? isActionLiveRunnable(activeConfig, lastResolutionPreview.actionId)
      : false;
  const canRunLiveAction =
    !isDirty &&
    lastResolutionPreview?.status === "resolved" &&
    resolvedLiveRunnable;
  const sessionSummary = summarizeVerificationSession(verificationSession);
  const currentVerificationStep = activeVerificationStep(verificationSession);
  const suggestedSessionResult = deriveVerificationSessionResult(
    currentVerificationStep,
    lastResolutionPreview,
    selectedControlId,
    selectedLayer,
  );
  const hasVerificationResults = verificationSession
    ? verificationSession.steps.some((step) => step.result !== "pending")
    : false;

  function updateSelectedMenuItems(updateItems: (items: MenuItem[]) => MenuItem[]) {
    updateSelectedActionDraft((action) =>
      withMenuPayload(action, (payload) => ({
        ...payload,
        items: updateItems(payload.items),
      })),
    );
  }

  function addMenuActionItem(parentId?: string) {
    const fallbackAction = menuActionOptions[0];
    if (!selectedAction || !fallbackAction) {
      return;
    }

    const existingIds =
      selectedMenuPayload ? collectMenuItemIds(selectedMenuPayload.items) : [];
    const nextItem = createDefaultActionMenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );

    updateSelectedMenuItems((items) => appendMenuItem(items, parentId ?? null, nextItem));
  }

  function addSubmenuItem(parentId?: string) {
    const fallbackAction = menuActionOptions[0];
    if (!selectedAction || !fallbackAction) {
      return;
    }

    const existingIds =
      selectedMenuPayload ? collectMenuItemIds(selectedMenuPayload.items) : [];
    const nextItem = createDefaultSubmenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );

    updateSelectedMenuItems((items) => appendMenuItem(items, parentId ?? null, nextItem));
  }

  function renderMenuItemEditor(
    item: MenuItem,
    depth: number,
    canRemove: boolean,
  ) {
    return (
      <div
        className="compound-card compound-card--menu"
        key={item.id}
        style={{ marginLeft: `${depth * 18}px` }}
      >
        <div className="compound-card__header">
          <div>
            <strong>{item.label}</strong>
            <span className="compound-card__meta">
              {item.kind === "action" ? "Пункт действия" : "Подменю"}
            </span>
          </div>
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            disabled={!canRemove}
            onClick={() => {
              updateSelectedMenuItems((items) => removeMenuItem(items, item.id));
            }}
          >
            Удалить
          </button>
        </div>

        <div className="editor-grid">
          <div className="field">
            <span className="field__label">ID пункта меню</span>
            <code className="field__static">{item.id}</code>
          </div>

          <label className="field">
            <span className="field__label">Название</span>
            <input
              type="text"
              value={item.label}
              onChange={(event) => {
                updateSelectedMenuItems((items) =>
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    label: event.target.value,
                  })),
                );
              }}
            />
          </label>

          <label className="field field--inline">
            <span className="field__label">Включено</span>
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(event) => {
                updateSelectedMenuItems((items) =>
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    enabled: event.target.checked,
                  })),
                );
              }}
            />
          </label>

          {item.kind === "action" ? (
            <label className="field">
              <span className="field__label">Ссылка на действие</span>
              <select
                value={item.actionRef}
                onChange={(event) => {
                  updateSelectedMenuItems((items) =>
                    updateMenuItem(items, item.id, (currentItem) =>
                      currentItem.kind === "action"
                        ? {
                            ...currentItem,
                            actionRef: event.target.value,
                          }
                        : currentItem,
                    ),
                  );
                }}
              >
                {menuActionOptions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.pretty} ({action.type})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <div className="field__header">
                <span className="field__label">Вложенные пункты</span>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addMenuActionItem(item.id);
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить действие
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addSubmenuItem(item.id);
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить подменю
                  </button>
                </div>
              </div>

              <div className="stack-list">
                {item.items.map((childItem) =>
                  renderMenuItemEditor(
                    childItem,
                    depth + 1,
                    item.items.length > 1,
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  function handleStartVerificationSession() {
    if (!activeConfig) {
      return;
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
      setLastRuntimeError(null);
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
    const captureForStep =
      currentVerificationStep?.observedAt &&
      lastEncodedKey?.receivedAt === currentVerificationStep.observedAt
        ? lastCapture
        : null;
    const previewForStep =
      currentVerificationStep?.observedAt &&
      lastEncodedKey?.receivedAt === currentVerificationStep.observedAt
        ? lastResolutionPreview
        : null;

    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession
          ? finalizeVerificationStep(
              currentSession,
              result,
              captureForStep,
              previewForStep,
              currentVerificationStep?.notes,
            )
          : currentSession,
      );
    });
  }

  function handleVerificationNotesChange(notes: string) {
    startTransition(() => {
      setVerificationSession((currentSession) =>
        currentSession ? updateVerificationStepNotes(currentSession, notes) : currentSession,
      );
    });
  }

  function handleResetVerificationSession() {
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
      const suggestedPath = `naga-verification-${verificationSession.sessionId}.json`;
      const path = await save({
        title: "Экспорт сессии проверки",
        defaultPath: suggestedPath,
        filters: [
          {
            name: "JSON",
            extensions: ["json"],
          },
        ],
      });

      if (!path) {
        return;
      }

      const normalizedPath = path.toLowerCase().endsWith(".json") ? path : `${path}.json`;
      const report = createVerificationSessionExport(verificationSession);
      const writtenPath = await exportVerificationSession(
        normalizedPath,
        JSON.stringify(report, null, 2),
      );

      startTransition(() => {
        setError(null);
        setLastRuntimeError(null);
        setLastVerificationExportPath(writtenPath);
      });
    } catch (unknownError) {
      startTransition(() => {
        setError(normalizeCommandError(unknownError));
      });
    }
  }

  useEffect(() => {
    if (!activeConfig || !effectiveProfileId) {
      return;
    }

    if (
      selectedAppMappingId === null ||
      !selectedAppMappings.some((mapping) => mapping.id === selectedAppMappingId)
    ) {
      startTransition(() => {
        setSelectedAppMappingId(selectedAppMappings[0]?.id ?? null);
      });
    }
  }, [activeConfig, effectiveProfileId, selectedAppMappingId, selectedAppMappings]);

  const familySections = controlFamilyOrder.map((family) => ({
    family,
    entries:
      activeConfig?.physicalControls
        .filter((control) => control.family === family)
        .map((control) => ({
          control,
          binding: bindingByControlId.get(control.id) ?? null,
          action: (() => {
            const binding = bindingByControlId.get(control.id) ?? null;
            return binding ? actionById.get(binding.actionRef) ?? null : null;
          })(),
          mapping: encoderByControlId.get(control.id) ?? null,
          isSelected: control.id === selectedControlId,
        })) ?? [],
  }));

  const isAssignmentsMode = workspaceMode === "buttons";
  const isProfilesMode = workspaceMode === "profiles";
  const isVerificationMode = workspaceMode === "verification";
  const isExpertMode = workspaceMode === "advanced";
  const activeModeCopy = workspaceModeCopy.find((mode) => mode.value === workspaceMode)!;
  const showDeviceSurface = isAssignmentsMode || isVerificationMode;
  const showLayerRail = !isProfilesMode;
  const showProfileEditor = isProfilesMode;
  const showSettingsPanel = isExpertMode;
  const showControlProperties = isVerificationMode || isExpertMode;
  const showControlStrip = isAssignmentsMode;
  const showBindingEditor = isAssignmentsMode;
  const showSignalPanel = isExpertMode;
  const showVerificationPanel = isVerificationMode;
  const showActionEditor = isExpertMode;
  const showSnippetPanel = isExpertMode;
  const showRuntimePanel = isVerificationMode || isExpertMode;
  const showWindowCapturePanel = isExpertMode;
  const showPreviewPanel = isExpertMode;
  const showExecutionPanel = isExpertMode;
  const showDebugPanel = isExpertMode;
  const showProfileRouting = isProfilesMode;
  const showPersistencePanel = isExpertMode;
  const workspaceClass =
    isAssignmentsMode || isProfilesMode ? "workspace workspace--1col" : "workspace workspace--2col";

  function surfacePrimaryLabel(binding: Binding | null, action: Action | null): string {
    if (!binding) {
      return "Не назначено";
    }

    if (!binding.enabled) {
      return `${binding.label} · отключено`;
    }

    return binding.label || action?.pretty || "Назначено";
  }

  function renderHotspotButtons(
    entries: ControlSurfaceEntry[],
    hotspots: Record<string, { left: number; top: number; label: string; size?: "sm" | "lg" }>,
  ) {
    return entries.map((entry) => {
      const pos = hotspots[entry.control.id];
      if (!pos) return null;
      return (
        <button
          type="button"
          key={entry.control.id}
          className={`mouse-visual__hotspot${
            entry.isSelected ? " mouse-visual__hotspot--selected" : ""
          }${pos.size === "sm" ? " mouse-visual__hotspot--sm" : ""}${
            pos.size === "lg" ? " mouse-visual__hotspot--lg" : ""
          }`}
          style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
          onClick={() => {
            startTransition(() => {
              setSelectedControlId(entry.control.id);
            });
          }}
          title={`${entry.control.defaultName} · ${surfacePrimaryLabel(
            entry.binding,
            entry.action,
          )}`}
        >
          {pos.label}
        </button>
      );
    });
  }

  function renderMouseVisualization(allEntries: ControlSurfaceEntry[]) {
    const selectedEntry = allEntries.find((e) => e.isSelected);

    return (
      <div className="mouse-visual-stack">
        {/* Top-down view: clicks, wheel, DPI, aux, side buttons */}
        <div className="mouse-visual mouse-visual--top">
          <img
            className="mouse-visual__img"
            src="/assets/naga-top.png"
            alt="Razer Naga V2 HyperSpeed — вид сверху"
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="mouse-visual__overlay">
            {renderHotspotButtons(allEntries, topViewHotspots)}
          </div>
          <span className="mouse-visual__zone-label">Верхняя панель</span>
        </div>

        {/* Side view: thumb grid 1-12 */}
        <div className="mouse-visual mouse-visual--side">
          <img
            className="mouse-visual__img"
            src="/assets/naga-side.png"
            alt="Razer Naga V2 HyperSpeed — боковая клавиатура"
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="mouse-visual__overlay">
            {renderHotspotButtons(allEntries, sideViewHotspots)}
          </div>
          <span className="mouse-visual__zone-label">Боковая клавиатура</span>
        </div>

        <div className="mouse-visual__label">
          {selectedEntry ? (
            <>
              <strong>{selectedEntry.control.defaultName}</strong>
              {" · "}
              {surfacePrimaryLabel(selectedEntry.binding, selectedEntry.action)}
            </>
          ) : (
            "Нажмите на кнопку мыши"
          )}
          <br />
          <span className="mouse-visual__layer-tag">
            {labelForLayer(selectedLayer)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          Naga Studio
          <strong>Razer Naga V2 HyperSpeed</strong>
        </div>
        {workspaceModeCopy.map((mode) => (
          <button
            key={mode.value}
            type="button"
            className={`nav-item${workspaceMode === mode.value ? " nav-item--active" : ""}`}
            onClick={() => {
              startTransition(() => {
                setWorkspaceMode(mode.value);
              });
            }}
          >
            {mode.label}
          </button>
        ))}
        <div className="sidebar__sep" />
        <div className="sidebar__section">
          <span className="sidebar__section-label">Профиль</span>
          <div className="sidebar__section-row">
            <select
              className="sidebar__select"
              value={effectiveProfileId ?? ""}
              onChange={(event) => {
                startTransition(() => {
                  setSelectedProfileId(event.target.value);
                });
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {isProfilesMode ? (
              <button
                type="button"
                className="nav-item"
                onClick={handleCreateProfile}
                title="Добавить профиль"
              >
                +
              </button>
            ) : null}
          </div>
        </div>
        {showLayerRail ? (
          <div className="sidebar__section">
            <span className="sidebar__section-label">Слой</span>
            <div className="layer-toggle">
              {layerCopy.map((layer) => (
                <button
                  key={layer.value}
                  type="button"
                  className={`layer-toggle__btn${selectedLayer === layer.value ? " layer-toggle__btn--active" : ""}`}
                  disabled={Boolean(verificationSession)}
                  onClick={() => {
                    startTransition(() => {
                      setSelectedLayer(layer.value);
                    });
                  }}
                >
                  {layer.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className={`sidebar__status${isDirty ? " sidebar__status--dirty" : ""}`}>
          {isDirty ? "Есть несохранённые изменения" : stateLabel(viewState)}
        </div>
      </aside>

      <div className="content">
        <div className="toolbar">
          <span className="toolbar__title">{activeModeCopy.heading}</span>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--secondary"
            onClick={() => {
              void refreshConfig();
            }}
            disabled={viewState === "loading" || viewState === "saving"}
          >
            Перезагрузить
          </button>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--secondary"
            onClick={resetDraft}
            disabled={!snapshot || !isDirty || viewState === "loading" || viewState === "saving"}
          >
            Сбросить
          </button>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--primary"
            onClick={() => {
              if (activeConfig) {
                void persistConfig(activeConfig);
              }
            }}
            disabled={
              !activeConfig ||
              !isDirty ||
              viewState === "loading" ||
              viewState === "saving"
            }
          >
            Сохранить
          </button>
        </div>

        {activeConfig ? (
          <section className={workspaceClass}>
            <div className="workspace__left">
              {showDeviceSurface ? (
                <section className="panel">
                  {renderMouseVisualization(
                    familySections.flatMap((section) => section.entries),
                  )}
                </section>
              ) : null}

              {showControlStrip ? (
                selectedControl ? (
                  <div className="control-strip">
                    <span className="control-strip__name">{selectedControl.defaultName}</span>
                    <span className="control-strip__action">
                      {selectedBinding
                        ? `${selectedBinding.label} · ${describeActionSummary(selectedAction, snippetById)}`
                        : "Назначение не создано"}
                    </span>
                    <span className="control-strip__status">
                      <span className={`badge ${badgeClassForCapability(selectedControl.capabilityStatus)}`}>
                        {labelForCapability(selectedControl.capabilityStatus)}
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="control-strip control-strip--empty">
                    Выберите кнопку на схеме мыши
                  </div>
                )
              ) : null}

              {showProfileEditor ? (
                <section className="panel">
                  <p className="panel__eyebrow">Параметры профиля</p>
                  {activeProfile ? (
                    <div className="editor-grid">
                      <label className="field">
                        <span className="field__label">Имя</span>
                        <input
                          type="text"
                          value={activeProfile.name}
                          onChange={(event) => {
                            updateDraft((config) =>
                              upsertProfile(config, {
                                ...activeProfile,
                                name: event.target.value,
                              }),
                            );
                          }}
                        />
                      </label>

                      <label className="field">
                        <span className="field__label">Описание</span>
                        <textarea
                          rows={3}
                          value={activeProfile.description ?? ""}
                          onChange={(event) => {
                            updateDraft((config) =>
                              upsertProfile(config, {
                                ...activeProfile,
                                description: event.target.value || undefined,
                              }),
                            );
                          }}
                        />
                      </label>

                      <label className="field">
                        <span className="field__label">Приоритет</span>
                        <input
                          type="number"
                          value={activeProfile.priority}
                          onChange={(event) => {
                            updateDraft((config) =>
                              upsertProfile(config, {
                                ...activeProfile,
                                priority: Number(event.target.value || 0),
                              }),
                            );
                          }}
                        />
                      </label>

                      <label className="field field--inline">
                        <span className="field__label">Включён</span>
                        <input
                          type="checkbox"
                          checked={activeProfile.enabled}
                          onChange={(event) => {
                            updateDraft((config) =>
                              upsertProfile(config, {
                                ...activeProfile,
                                enabled: event.target.checked,
                              }),
                            );
                          }}
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="panel__muted">Профиль не выбран.</p>
                  )}
                </section>
              ) : null}

              {showProfileRouting ? (
                <section className="panel">
                  <p className="panel__eyebrow">Правила для приложений</p>
                  <h3>{activeProfile?.name ?? "Профиль не выбран"}</h3>

                  <div className="editor-grid">
                    <div className="route-list">
                      {selectedAppMappings.map((mapping) => (
                        <button
                          key={mapping.id}
                          type="button"
                          className={`card${
                            selectedAppMapping?.id === mapping.id ? " card--active" : ""
                          }`}
                          onClick={() => {
                            setSelectedAppMappingId(mapping.id);
                          }}
                        >
                          <strong>{mapping.exe}</strong>
                          <span>Приоритет {mapping.priority}</span>
                          <code>{mapping.id}</code>
                          {!mapping.enabled ? (
                            <span className="badge badge--muted">Отключено</span>
                          ) : null}
                        </button>
                      ))}
                    </div>

                    {lastCapture && !lastCapture.ignored && activeProfile ? (
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => {
                          updateDraft((config) =>
                            createAppMappingFromCapture(
                              config,
                              activeProfile.id,
                              activeProfile.priority,
                              lastCapture.exe,
                              lastCapture.title,
                              false,
                            ),
                          );
                        }}
                      >
                        Создать правило из захвата
                      </button>
                    ) : null}

                    {selectedAppMapping ? (
                      <>
                        <label className="field">
                          <span className="field__label">Исполняемый файл</span>
                          <input
                            type="text"
                            value={selectedAppMapping.exe}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertAppMapping(config, {
                                  ...selectedAppMapping,
                                  exe: event.target.value,
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field field--inline">
                          <span className="field__label">Правило включено</span>
                          <input
                            type="checkbox"
                            checked={selectedAppMapping.enabled}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertAppMapping(config, {
                                  ...selectedAppMapping,
                                  enabled: event.target.checked,
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field">
                          <span className="field__label">Приоритет</span>
                          <input
                            type="number"
                            value={selectedAppMapping.priority}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertAppMapping(config, {
                                  ...selectedAppMapping,
                                  priority: Number(event.target.value || 0),
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field">
                          <span className="field__label">Фильтры заголовка</span>
                          <input
                            type="text"
                            value={(selectedAppMapping.titleIncludes ?? []).join(", ")}
                            placeholder="часть заголовка, ещё часть заголовка"
                            onChange={(event) => {
                              const titleIncludes = parseCommaSeparatedUniqueValues(
                                event.target.value,
                              );
                              updateDraft((config) =>
                                upsertAppMapping(config, {
                                  ...selectedAppMapping,
                                  titleIncludes:
                                    titleIncludes.length > 0 ? titleIncludes : undefined,
                                }),
                              );
                            }}
                          />
                        </label>

                        {lastCapture && !lastCapture.ignored ? (
                          <div className="editor-grid">
                            <p className="panel__muted">
                              Последний захват: <code>{lastCapture.exe}</code> с
                              заголовком <code>{lastCapture.title || "(пусто)"}</code>.
                            </p>
                            <button
                              type="button"
                              className="action-button action-button--secondary"
                              onClick={() => {
                                updateDraft((config) =>
                                  upsertAppMapping(config, {
                                    ...selectedAppMapping,
                                    exe: lastCapture.exe,
                                    titleIncludes: lastCapture.title
                                      ? [lastCapture.title]
                                      : undefined,
                                  }),
                                );
                              }}
                            >
                              Подставить exe и заголовок
                            </button>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="panel__muted">
                        Для этого профиля ещё нет правил для приложений.
                      </p>
                    )}
                  </div>
                </section>
              ) : null}

              {showActionEditor ? (
                <section className="panel">
                  <p className="panel__eyebrow">Действие кнопки</p>
                  {selectedAction ? (
                    <div className="editor-grid">
                      <label className="field">
                        <span className="field__label">Название действия</span>
                        <input
                          type="text"
                          value={selectedAction.pretty}
                          onChange={(event) => {
                            updateSelectedActionDraft((action) => ({
                              ...action,
                              pretty: event.target.value,
                            }));
                          }}
                        />
                      </label>

                      <label className="field">
                        <span className="field__label">Тип действия</span>
                        <select
                          value={selectedAction.type}
                          onChange={(event) => {
                            updateDraft((config) =>
                              coerceActionType(
                                config,
                                selectedAction.id,
                                event.target.value as ActionType,
                              ),
                            );
                          }}
                        >
                          {editableActionTypes.map((actionType) => (
                            <option key={actionType.value} value={actionType.value}>
                              {actionType.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="field">
                        <span className="field__label">Заметки</span>
                        <textarea
                          rows={3}
                          value={selectedAction.notes ?? ""}
                          onChange={(event) => {
                            updateSelectedActionDraft((action) => ({
                              ...action,
                              notes: event.target.value || undefined,
                            }));
                          }}
                        />
                      </label>

                      {selectedAction.type === "shortcut" && "key" in selectedAction.payload ? (
                        <>
                          <label className="field">
                            <span className="field__label">Клавиша</span>
                            <input
                              type="text"
                              value={selectedAction.payload.key}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withShortcutPayload(action, (payload) => ({
                                    ...payload,
                                    key: event.target.value,
                                  })),
                                );
                              }}
                            />
                          </label>

                          <div className="field">
                            <span className="field__label">Модификаторы</span>
                            <div className="toggle-grid">
                              {(
                                [
                                  ["ctrl", "Ctrl"],
                                  ["shift", "Shift"],
                                  ["alt", "Alt"],
                                  ["win", "Win"],
                                ] as const
                              ).map(([modifierKey, modifierLabel]) => (
                                <label className="toggle-chip" key={modifierKey}>
                                  <input
                                    type="checkbox"
                                    checked={
                                      (selectedAction.payload as ShortcutActionPayload)[
                                        modifierKey
                                      ]
                                    }
                                    onChange={(event) => {
                                      updateSelectedActionDraft((action) =>
                                        withShortcutPayload(action, (payload) => ({
                                          ...payload,
                                          [modifierKey]: event.target.checked,
                                        })),
                                      );
                                    }}
                                  />
                                  <span>{modifierLabel}</span>
                                </label>
                              ))}
                            </div>
                          </div>

                          <label className="field">
                            <span className="field__label">Исходная строка шортката</span>
                            <input
                              type="text"
                              value={selectedAction.payload.raw ?? ""}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withShortcutPayload(action, (payload) => ({
                                    ...payload,
                                    raw: event.target.value || undefined,
                                  })),
                                );
                              }}
                            />
                          </label>
                        </>
                      ) : null}

                      {selectedAction.type === "textSnippet" &&
                      "source" in selectedAction.payload ? (
                        <>
                          <label className="field">
                            <span className="field__label">Источник фрагмента</span>
                            <select
                              value={selectedAction.payload.source}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withTextSnippetPayload(action, (payload) =>
                                    event.target.value === "libraryRef"
                                      ? {
                                          source: "libraryRef",
                                          snippetId:
                                            activeConfig.snippetLibrary[0]?.id ??
                                            "snippet-missing",
                                        }
                                      : {
                                          source: "inline",
                                          text:
                                            payload.source === "inline"
                                              ? payload.text
                                              : action.pretty,
                                          pasteMode:
                                            payload.source === "inline"
                                              ? payload.pasteMode
                                              : "clipboardPaste",
                                          tags:
                                            payload.source === "inline"
                                              ? payload.tags
                                              : [],
                                        },
                                  ),
                                );
                              }}
                            >
                              <option value="inline">Встроенный текст</option>
                              <option
                                value="libraryRef"
                                disabled={activeConfig.snippetLibrary.length === 0}
                              >
                                Библиотека фрагментов
                              </option>
                            </select>
                          </label>

                          {selectedAction.payload.source === "inline" ? (
                            <>
                              <label className="field">
                                <span className="field__label">Текст</span>
                                <textarea
                                  rows={5}
                                  value={selectedAction.payload.text}
                                  onChange={(event) => {
                                    updateSelectedActionDraft((action) =>
                                      withTextSnippetPayload(action, (payload) =>
                                        payload.source === "inline"
                                          ? {
                                              ...payload,
                                              text: event.target.value,
                                            }
                                          : payload,
                                      ),
                                    );
                                  }}
                                />
                              </label>

                              <label className="field">
                                <span className="field__label">Способ вставки</span>
                                <select
                                  value={selectedAction.payload.pasteMode}
                                  onChange={(event) => {
                                    updateSelectedActionDraft((action) =>
                                      withTextSnippetPayload(action, (payload) =>
                                        payload.source === "inline"
                                          ? {
                                              ...payload,
                                              pasteMode: event.target.value as
                                                | "clipboardPaste"
                                                | "sendText",
                                            }
                                          : payload,
                                      ),
                                    );
                                  }}
                                >
                                  <option value="clipboardPaste">Через буфер обмена</option>
                                  <option value="sendText">Прямой ввод текста</option>
                                </select>
                              </label>

                              <label className="field">
                                <span className="field__label">Теги</span>
                                <input
                                  type="text"
                                  value={selectedAction.payload.tags.join(", ")}
                                  placeholder="тег1, тег2, тег3"
                                  onChange={(event) => {
                                    updateSelectedActionDraft((action) =>
                                      withTextSnippetPayload(action, (payload) =>
                                        payload.source === "inline"
                                          ? {
                                              ...payload,
                                              tags: parseCommaSeparatedTags(event.target.value),
                                            }
                                          : payload,
                                      ),
                                    );
                                  }}
                                />
                              </label>

                              <button
                                type="button"
                                className="action-button action-button--secondary"
                                onClick={() => {
                                  updateDraft((config) =>
                                    promoteInlineSnippetActionToLibrary(
                                      config,
                                      selectedAction.id,
                                      selectedAction.pretty,
                                    ),
                                  );
                                }}
                              >
                                Создать запись в библиотеке
                              </button>
                            </>
                          ) : (
                            <label className="field">
                              <span className="field__label">Запись из библиотеки</span>
                              <select
                                value={selectedAction.payload.snippetId}
                                onChange={(event) => {
                                  updateSelectedActionDraft((action) =>
                                    withTextSnippetPayload(action, (payload) =>
                                      payload.source === "libraryRef"
                                        ? {
                                            ...payload,
                                            snippetId: event.target.value,
                                          }
                                        : payload,
                                    ),
                                  );
                                }}
                              >
                                {activeConfig.snippetLibrary.map((snippet) => (
                                  <option key={snippet.id} value={snippet.id}>
                                    {snippet.name} ({snippet.id})
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      ) : null}

                      {selectedSequencePayload ? (
                        <div className="field">
                          <div className="field__header">
                            <span className="field__label">Шаги последовательности</span>
                            <div className="editor-actions">
                              {(
                                [
                                  ["send", "Добавить отправку"],
                                  ["text", "Добавить текст"],
                                  ["sleep", "Добавить паузу"],
                                  ["launch", "Добавить запуск"],
                                ] as const
                              ).map(([stepType, label]) => (
                                <button
                                  type="button"
                                  key={stepType}
                                  className="action-button action-button--secondary action-button--small"
                                  onClick={() => {
                                    updateSelectedActionDraft((action) =>
                                      withSequencePayload(action, (payload) => ({
                                        ...payload,
                                        steps: [
                                          ...payload.steps,
                                          createDefaultSequenceStep(stepType),
                                        ],
                                      })),
                                    );
                                  }}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="stack-list">
                            {selectedSequencePayload.steps.map((step, index) => (
                              <div className="compound-card" key={`${step.type}-${index}`}>
                                <div className="compound-card__header">
                                  <div>
                                    <strong>Шаг {index + 1}</strong>
                                    <span className="compound-card__meta">
                                      {labelForSequenceStep(step.type)}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    className="action-button action-button--secondary action-button--small"
                                    disabled={selectedSequencePayload.steps.length === 1}
                                    onClick={() => {
                                      updateSelectedActionDraft((action) =>
                                        withSequencePayload(action, (payload) => ({
                                          ...payload,
                                          steps: payload.steps.filter(
                                            (_, stepIndex) => stepIndex !== index,
                                          ),
                                        })),
                                      );
                                    }}
                                  >
                                    Удалить
                                  </button>
                                </div>

                                <div className="editor-grid">
                                  <label className="field">
                                    <span className="field__label">Тип шага</span>
                                    <select
                                      value={step.type}
                                      onChange={(event) => {
                                        updateSelectedActionDraft((action) =>
                                          withSequencePayload(action, (payload) => ({
                                            ...payload,
                                            steps: payload.steps.map(
                                              (currentStep, stepIndex) =>
                                                stepIndex === index
                                                  ? coerceSequenceStepType(
                                                      currentStep,
                                                      event.target
                                                        .value as SequenceStep["type"],
                                                    )
                                                  : currentStep,
                                            ),
                                          })),
                                        );
                                      }}
                                    >
                                      <option value="send">Отправка сочетания</option>
                                      <option value="text">Ввод текста</option>
                                      <option value="sleep">Пауза</option>
                                      <option value="launch">Запуск</option>
                                    </select>
                                  </label>

                                  {step.type !== "sleep" ? (
                                    <label className="field">
                                      <span className="field__label">Значение</span>
                                      <input
                                        type="text"
                                        value={step.value}
                                        onChange={(event) => {
                                          updateSelectedActionDraft((action) =>
                                            withSequencePayload(action, (payload) => ({
                                              ...payload,
                                              steps: payload.steps.map(
                                                (currentStep, stepIndex) =>
                                                  stepIndex === index &&
                                                  "value" in currentStep
                                                    ? {
                                                        ...currentStep,
                                                        value: event.target.value,
                                                      }
                                                    : currentStep,
                                              ),
                                            })),
                                          );
                                        }}
                                      />
                                    </label>
                                  ) : null}

                                  <label className="field">
                                    <span className="field__label">Задержка (мс)</span>
                                    <input
                                      type="number"
                                      min={0}
                                      value={step.delayMs ?? ""}
                                      onChange={(event) => {
                                        const nextDelay = parseOptionalNumber(
                                          event.target.value,
                                        );
                                        updateSelectedActionDraft((action) =>
                                          withSequencePayload(action, (payload) => ({
                                            ...payload,
                                            steps: payload.steps.map(
                                              (currentStep, stepIndex) =>
                                                stepIndex === index
                                                  ? setSequenceStepDelay(
                                                      currentStep,
                                                      nextDelay,
                                                    )
                                                  : currentStep,
                                            ),
                                          })),
                                        );
                                      }}
                                    />
                                  </label>

                                  {step.type === "launch" ? (
                                    <>
                                      <label className="field">
                                        <span className="field__label">Аргументы</span>
                                        <input
                                          type="text"
                                          value={(step.args ?? []).join(", ")}
                                          placeholder="арг1, арг2"
                                          onChange={(event) => {
                                            updateSelectedActionDraft((action) =>
                                              withSequencePayload(action, (payload) => ({
                                                ...payload,
                                                steps: payload.steps.map(
                                                  (currentStep, stepIndex) =>
                                                    stepIndex === index &&
                                                    currentStep.type === "launch"
                                                      ? {
                                                          ...currentStep,
                                                          args:
                                                            parseCommaSeparatedList(
                                                              event.target.value,
                                                            ),
                                                        }
                                                      : currentStep,
                                                ),
                                              })),
                                            );
                                          }}
                                        />
                                      </label>

                                      <label className="field">
                                        <span className="field__label">Рабочая папка</span>
                                        <input
                                          type="text"
                                          value={step.workingDir ?? ""}
                                          onChange={(event) => {
                                            updateSelectedActionDraft((action) =>
                                              withSequencePayload(action, (payload) => ({
                                                ...payload,
                                                steps: payload.steps.map(
                                                  (currentStep, stepIndex) =>
                                                    stepIndex === index &&
                                                    currentStep.type === "launch"
                                                      ? {
                                                          ...currentStep,
                                                          workingDir:
                                                            event.target.value ||
                                                            undefined,
                                                        }
                                                      : currentStep,
                                                ),
                                              })),
                                            );
                                          }}
                                        />
                                      </label>
                                    </>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {selectedAction.type === "launch" && "target" in selectedAction.payload ? (
                        <>
                          <label className="field">
                            <span className="field__label">Цель запуска</span>
                            <input
                              type="text"
                              value={selectedAction.payload.target}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withLaunchPayload(action, (payload) => ({
                                    ...payload,
                                    target: event.target.value,
                                  })),
                                );
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Аргументы</span>
                            <input
                              type="text"
                              value={(selectedAction.payload.args ?? []).join(", ")}
                              placeholder="арг1, арг2"
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withLaunchPayload(action, (payload) => ({
                                    ...payload,
                                    args: parseCommaSeparatedList(event.target.value),
                                  })),
                                );
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Рабочая папка</span>
                            <input
                              type="text"
                              value={selectedAction.payload.workingDir ?? ""}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withLaunchPayload(action, (payload) => ({
                                    ...payload,
                                    workingDir: event.target.value || undefined,
                                  })),
                                );
                              }}
                            />
                          </label>
                        </>
                      ) : null}

                      {selectedMenuPayload ? (
                        <div className="field">
                          <div className="field__header">
                            <span className="field__label">Пункты меню</span>
                            <div className="editor-actions">
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  addMenuActionItem();
                                }}
                                disabled={menuActionOptions.length === 0}
                              >
                                Добавить действие
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  addSubmenuItem();
                                }}
                                disabled={menuActionOptions.length === 0}
                              >
                                Добавить подменю
                              </button>
                            </div>
                          </div>

                          {menuActionOptions.length === 0 ? (
                            <div className="notice notice--warning">
                              <strong>Нет доступных действий для меню</strong>
                              <p>
                                Пункты меню должны ссылаться на другие действия.
                                Создайте хотя бы ещё одно действие.
                              </p>
                            </div>
                          ) : null}

                          <div className="stack-list">
                            {selectedMenuPayload.items.map((item) =>
                              renderMenuItemEditor(
                                item,
                                0,
                                selectedMenuPayload.items.length > 1,
                              ),
                            )}
                          </div>
                        </div>
                      ) : null}

                      <p className="panel__muted">
                        {describeActionSummary(selectedAction, snippetById)}
                        {" "}Назначений: {selectedActionUsageCount}.
                      </p>
                    </div>
                  ) : (
                    <p className="panel__muted">
                      Сначала выберите или создайте назначение.
                    </p>
                  )}
                </section>
              ) : null}

              {showSnippetPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Библиотека фрагментов</p>
                  {selectedAction &&
                  selectedAction.type === "textSnippet" &&
                  "source" in selectedAction.payload ? (
                    selectedAction.payload.source === "libraryRef" ? (
                      selectedSnippet ? (
                        <div className="editor-grid">
                          <div className="field">
                            <span className="field__label">ID фрагмента</span>
                            <code className="field__static">{selectedSnippet.id}</code>
                          </div>

                          <label className="field">
                            <span className="field__label">Название фрагмента</span>
                            <input
                              type="text"
                              value={selectedSnippet.name}
                              onChange={(event) => {
                                updateSelectedSnippetDraft((snippet) => ({
                                  ...snippet,
                                  name: event.target.value,
                                }));
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Текст фрагмента</span>
                            <textarea
                              rows={6}
                              value={selectedSnippet.text}
                              onChange={(event) => {
                                updateSelectedSnippetDraft((snippet) => ({
                                  ...snippet,
                                  text: event.target.value,
                                }));
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Способ вставки</span>
                            <select
                              value={selectedSnippet.pasteMode}
                              onChange={(event) => {
                                updateSelectedSnippetDraft((snippet) => ({
                                  ...snippet,
                                  pasteMode: event.target.value as
                                    | "clipboardPaste"
                                    | "sendText",
                                }));
                              }}
                            >
                              <option value="clipboardPaste">Через буфер обмена</option>
                              <option value="sendText">Прямой ввод текста</option>
                            </select>
                          </label>

                          <label className="field">
                            <span className="field__label">Теги</span>
                            <input
                              type="text"
                              value={selectedSnippet.tags.join(", ")}
                              placeholder="тег1, тег2, тег3"
                              onChange={(event) => {
                                updateSelectedSnippetDraft((snippet) => ({
                                  ...snippet,
                                  tags: parseCommaSeparatedTags(event.target.value),
                                }));
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Заметки</span>
                            <textarea
                              rows={3}
                              value={selectedSnippet.notes ?? ""}
                              onChange={(event) => {
                                updateSelectedSnippetDraft((snippet) => ({
                                  ...snippet,
                                  notes: event.target.value || undefined,
                                }));
                              }}
                            />
                          </label>

                          <p className="panel__muted">
                            Этот фрагмент используют действий: {selectedSnippetUsageCount}.
                          </p>
                        </div>
                      ) : (
                        <div className="notice notice--error">
                          <strong>Запись библиотеки не найдена</strong>
                          <p>
                            Выбранное действие ссылается на фрагмент, которого нет
                            в <code>snippetLibrary</code>.
                          </p>
                        </div>
                      )
                    ) : (
                      <p className="panel__muted">
                        Сейчас текст хранится прямо внутри действия.
                      </p>
                    )
                  ) : (
                    <p className="panel__muted">
                      Выберите действие типа <code>textSnippet</code>, чтобы
                      редактировать библиотеку фрагментов.
                    </p>
                  )}
                </section>
              ) : null}
            </div>

            <div className="workspace__right">
              {showControlProperties ? (
                <section className="panel panel--accent">
                  <p className="panel__eyebrow">
                    {isVerificationMode ? "Проверяемая кнопка" : "Свойства кнопки"}
                  </p>
                  {selectedControl ? (
                    <>
                      <h2>{selectedControl.defaultName}</h2>
                      {isExpertMode ? (
                        <p className="inspector__lede">
                          {selectedControl.notes ??
                            "Для этой кнопки пока нет дополнительных заметок."}
                        </p>
                      ) : null}

                      <div className="fact-grid">
                        <Fact
                          label="Статус"
                          value={labelForCapability(selectedControl.capabilityStatus)}
                        />
                        <Fact
                          label="Сигнал"
                          value={selectedEncoder?.encodedKey ?? "не назначен"}
                        />
                        {isExpertMode ? (
                          <>
                            <Fact
                              label="Можно переназначить"
                              value={selectedControl.remappable ? "Да" : "Нет"}
                            />
                            <Fact label="Группа" value={labelForControlFamily(selectedControl.family)} />
                            <Fact label="ID кнопки" value={selectedControl.id} />
                            <Fact
                              label="Источник сигнала"
                              value={labelForEncoderSource(selectedEncoder?.source)}
                            />
                          </>
                        ) : null}
                      </div>

                      {isVerificationMode || isExpertMode ? (
                        <label className="field">
                          <span className="field__label">Статус кнопки</span>
                          <select
                            value={selectedControl.capabilityStatus}
                            onChange={(event) => {
                              updateDraft((config) =>
                                updateControlCapabilityStatus(
                                  config,
                                  selectedControl.id,
                                  event.target.value as CapabilityStatus,
                                ),
                              );
                            }}
                          >
                            <option value="verified">Подтверждена</option>
                            <option value="needsValidation">Нужна проверка</option>
                            <option value="partiallyRemappable">Частично переназначается</option>
                            <option value="reserved">Зарезервирована</option>
                          </select>
                        </label>
                      ) : null}

                      <div className="inspector__binding-card">
                        <h3>Что сработает</h3>
                        {selectedBinding ? (
                          <>
                            <p>
                              <strong>{selectedBinding.label}</strong>
                            </p>
                            <p>{describeActionSummary(selectedAction, snippetById)}</p>
                            {workspaceMode === "advanced" ? (
                              <>
                                <p>
                                  Ссылка на действие: <code>{selectedBinding.actionRef}</code>
                                </p>
                                <p>
                                  Тип действия:{" "}
                                  <code>{selectedAction?.type ?? "действие отсутствует"}</code>
                                </p>
                              </>
                            ) : null}
                          </>
                        ) : (
                          <p>Для этой кнопки на текущем слое назначение ещё не создано.</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <p>Выберите кнопку на схеме мыши.</p>
                  )}
                </section>
              ) : null}

              {showBindingEditor ? (
                <section className="panel">
                  <p className="panel__eyebrow">Изменить действие</p>
                  {selectedControl && activeProfile && effectiveProfileId ? (
                    selectedBinding ? (
                      <div className="editor-grid">
                        <label className="field">
                          <span className="field__label">Название назначения</span>
                          <input
                            type="text"
                            value={selectedBinding.label}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertBinding(config, {
                                  ...selectedBinding,
                                  label: event.target.value,
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field field--inline">
                          <span className="field__label">Назначение включено</span>
                          <input
                            type="checkbox"
                            checked={selectedBinding.enabled}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertBinding(config, {
                                  ...selectedBinding,
                                  enabled: event.target.checked,
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field">
                          <span className="field__label">Найти действие</span>
                          <input
                            type="search"
                            placeholder="Поиск по имени, ID, типу или заметкам"
                            value={actionQuery}
                            onChange={(event) => {
                              setActionQuery(event.target.value);
                            }}
                          />
                        </label>

                        <label className="field">
                          <span className="field__label">Действие</span>
                          <select
                            value={selectedBinding.actionRef}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertBinding(config, {
                                  ...selectedBinding,
                                  actionRef: event.target.value,
                                }),
                              );
                            }}
                          >
                            {availableActions.map((action) => (
                              <option key={action.id} value={action.id}>
                                {action.pretty} ({action.type})
                              </option>
                            ))}
                          </select>
                        </label>

                        <p className="panel__muted">
                          {describeActionSummary(selectedAction, snippetById)}
                          {" "}Подходящих: {availableActions.length}. Назначений: {selectedActionUsageCount}.
                        </p>
                      </div>
                    ) : (
                      <div className="editor-grid">
                        <p className="panel__muted">
                          Для <code>{selectedControl.id}</code> ещё нет назначения на{" "}
                          <code>{activeProfile.id}</code> / <code>{selectedLayer}</code>.
                        </p>
                        <button
                          type="button"
                          className="action-button"
                          onClick={() => {
                            updateDraft((config) =>
                              ensurePlaceholderBinding(
                                config,
                                effectiveProfileId,
                                selectedLayer,
                                selectedControl,
                              ),
                            );
                          }}
                        >
                          Создать назначение
                        </button>
                      </div>
                    )
                  ) : (
                    <p className="panel__muted">
                      Выберите профиль и кнопку перед редактированием назначения.
                    </p>
                  )}
                </section>
              ) : null}

              {showSignalPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Сигнал кнопки</p>
                  {selectedControl ? (
                    selectedEncoder ? (
                      <div className="editor-grid">
                        <label className="field">
                          <span className="field__label">Код сигнала</span>
                          <input
                            type="text"
                            value={selectedEncoder.encodedKey}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertEncoderMapping(config, {
                                  ...selectedEncoder,
                                  encodedKey: event.target.value,
                                }),
                              );
                            }}
                          />
                        </label>

                        <label className="field">
                          <span className="field__label">Источник</span>
                          <select
                            value={selectedEncoder.source}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertEncoderMapping(config, {
                                  ...selectedEncoder,
                                  source: event.target.value as EncoderMapping["source"],
                                }),
                              );
                            }}
                          >
                            <option value="synapse">Synapse</option>
                            <option value="detected">Обнаружен</option>
                            <option value="reserved">Зарезервирован</option>
                          </select>
                        </label>

                        <label className="field field--inline">
                          <span className="field__label">Подтверждён</span>
                          <input
                            type="checkbox"
                            checked={selectedEncoder.verified}
                            onChange={(event) => {
                              updateDraft((config) =>
                                upsertEncoderMapping(config, {
                                  ...selectedEncoder,
                                  verified: event.target.checked,
                                }),
                              );
                            }}
                          />
                        </label>
                      </div>
                    ) : (
                      <div className="editor-grid">
                        <p className="panel__muted">
                          Для <code>{selectedControl.id}</code> на текущем слое ещё нет сигнала.
                        </p>
                        <button
                          type="button"
                          className="action-button"
                          onClick={() => {
                            updateDraft((config) =>
                              ensureEncoderMapping(config, selectedLayer, selectedControl),
                            );
                          }}
                        >
                          Создать временный сигнал
                        </button>
                      </div>
                    )
                  ) : (
                    <p className="panel__muted">
                      Выберите кнопку перед редактированием сигнала.
                    </p>
                  )}
                </section>
              ) : null}

              {showVerificationPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Проверка кнопки</p>
                  {selectedControl ? (
                    <div className="editor-grid">
                      <div className="compound-card">
                        <div className="compound-card__header">
                          <div>
                            <strong>Сессия проверки</strong>
                            <span className="compound-card__meta">
                              Пошаговая проверка с фиксацией результата по каждой кнопке.
                            </span>
                          </div>
                          <label className="field verification-session__scope">
                            <span className="field__label">Объём сессии</span>
                            <select
                              value={verificationScope}
                              onChange={(event) => {
                                setVerificationScope(
                                  event.target.value as VerificationSessionScope,
                                );
                              }}
                              disabled={Boolean(verificationSession)}
                            >
                              {verificationScopeCopy.map((scope) => (
                                <option key={scope.value} value={scope.value}>
                                  {scope.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <p className="panel__muted">
                          {
                            verificationScopeCopy.find((scope) => scope.value === verificationScope)
                              ?.body
                          }
                        </p>

                        <div className="fact-grid">
                          <Fact
                            label="Слой"
                            value={verificationSession?.layer ?? labelForLayer(selectedLayer)}
                          />
                          <Fact
                            label="Шаг"
                            value={
                              verificationSession
                                ? `${Math.min(
                                    verificationSession.activeStepIndex + 1,
                                    verificationSession.steps.length,
                                  )} / ${verificationSession.steps.length}`
                                : "—"
                            }
                          />
                          <Fact label="Совпало" value={String(sessionSummary.matched)} />
                          <Fact
                            label="Осталось"
                            value={String(sessionSummary.pending)}
                          />
                        </div>

                        {isDirty ? (
                          <div className="notice notice--warning">
                            <strong>Сначала сохраните черновик</strong>
                            <p>
                              Сессия проверки должна опираться на сохранённую конфигурацию,
                              иначе перехват и редактор будут смотреть на разные данные.
                            </p>
                          </div>
                        ) : null}

                        {runtimeSummary.status !== "running" ? (
                          <div className="notice notice--warning">
                            <strong>Фоновый перехват ещё не запущен</strong>
                            <p>
                              Для живой проверки сначала запустите перехват, потом начинайте
                              шаги сессии.
                            </p>
                          </div>
                        ) : null}

                        {currentVerificationStep ? (
                          <div className="editor-grid">
                            <p className="panel__muted">
                              Сейчас: {currentVerificationStep.controlLabel} (
                              {currentVerificationStep.controlId}).
                              Шаг начат: {formatTimestamp(currentVerificationStep.startedAt)}
                            </p>

                            <div className="fact-grid">
                              <Fact
                                label="Ожидалось"
                                value={currentVerificationStep.expectedEncodedKey ?? "н/д"}
                              />
                              <Fact
                                label="Настроено"
                                value={currentVerificationStep.configuredEncodedKey ?? "не назначено"}
                              />
                              <Fact
                                label="Наблюдалось"
                                value={currentVerificationStep.observedEncodedKey ?? "ничего"}
                              />
                              <Fact
                                label="Результат"
                                value={labelForVerificationResult(
                                  currentVerificationStep.result,
                                )}
                              />
                            </div>

                            {suggestedSessionResult ? (
                              <div
                                className={`notice ${
                                  suggestedSessionResult === "matched"
                                    ? "notice--ok"
                                    : suggestedSessionResult === "noSignal"
                                      ? "notice--warning"
                                      : "notice--info"
                                }`}
                              >
                                <strong>
                                  Подсказка:{" "}
                                  {labelForVerificationResult(suggestedSessionResult)}
                                </strong>
                                <p>
                                  {describeVerificationSessionSuggestion(
                                    suggestedSessionResult,
                                    currentVerificationStep,
                                  )}
                                </p>
                              </div>
                            ) : null}

                            <label className="field">
                              <span className="field__label">Заметка по шагу</span>
                              <textarea
                                rows={3}
                                value={currentVerificationStep.notes}
                                placeholder="Например: сработало только после повторного нажатия."
                                onChange={(event) => {
                                  handleVerificationNotesChange(event.target.value);
                                }}
                              />
                            </label>

                            <div className="editor-actions">
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleRestartVerificationStep();
                                }}
                                disabled={runtimeSummary.status !== "running" || isDirty}
                              >
                                Перезапустить шаг
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--small"
                                onClick={() => {
                                  handleVerificationResult("matched");
                                }}
                                disabled={!currentVerificationStep.observedEncodedKey}
                              >
                                Совпало
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("mismatched");
                                }}
                                disabled={!currentVerificationStep.observedEncodedKey}
                              >
                                Не совпало
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("noSignal");
                                }}
                              >
                                Нет сигнала
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("skipped");
                                }}
                              >
                                Пропустить
                              </button>
                            </div>
                          </div>
                        ) : verificationSession ? (
                          <div className="notice notice--ok">
                            <strong>Сессия завершена</strong>
                            <p>
                              Все шаги пройдены. Проверьте итоговую сводку и при желании
                              экспортируйте JSON-отчёт.
                            </p>
                          </div>
                        ) : null}

                        {lastVerificationExportPath ? (
                          <div className="notice notice--ok">
                            <strong>Отчёт сохранён</strong>
                            <p className="panel__path">{lastVerificationExportPath}</p>
                          </div>
                        ) : null}

                        <div className="editor-actions">
                          {verificationSession ? (
                            <button
                              type="button"
                              className="action-button action-button--secondary"
                              onClick={() => {
                                handleResetVerificationSession();
                              }}
                            >
                              Сбросить сессию
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="action-button"
                              onClick={() => {
                                handleStartVerificationSession();
                              }}
                              disabled={isDirty || runtimeSummary.status !== "running"}
                            >
                              Начать сессию
                            </button>
                          )}

                          <button
                            type="button"
                            className="action-button action-button--secondary"
                            onClick={() => {
                              void handleExportVerificationSession();
                            }}
                            disabled={!hasVerificationResults}
                          >
                            Экспорт JSON
                          </button>
                        </div>
                      </div>

                      {!verificationSession ? (
                        <>
                          <div className={`notice ${verificationAlignment.noticeClass}`}>
                            <strong>{verificationAlignment.title}</strong>
                            <p>{verificationAlignment.body}</p>
                            {lastObservedResolvedSelectedControl ? (
                              <p className="notice__meta">
                                Последняя проверка совпала с этой кнопкой и слоем.
                              </p>
                            ) : (
                              <p className="notice__meta">
                                Последний сигнал мог относиться к другой кнопке или к
                                ручной проверке.
                              </p>
                            )}
                          </div>

                          <div className="fact-grid">
                            <Fact label="Ожидалось" value={expectedEncodedKey ?? "н/д"} />
                            <Fact label="Настроено" value={selectedEncoder?.encodedKey ?? "не назначено"} />
                            <Fact label="Наблюдалось" value={lastObservedEncodedKey ?? "ничего"} />
                            <Fact
                              label="Время наблюдения"
                              value={
                                lastEncodedKey ? formatTimestamp(lastEncodedKey.receivedAt) : "н/д"
                              }
                            />
                          </div>

                          <div className="editor-actions">
                            <button
                              type="button"
                              className="action-button action-button--small"
                              onClick={() => {
                                updateDraft((config) =>
                                  seedExpectedEncoderMapping(config, selectedLayer, selectedControl),
                                );
                              }}
                              disabled={!expectedEncodedKey}
                            >
                              {selectedEncoder ? "Применить ожидаемый сигнал" : "Создать ожидаемый сигнал"}
                            </button>

                            <button
                              type="button"
                              className="action-button action-button--small action-button--secondary"
                              onClick={() => {
                                if (!lastObservedEncodedKey) {
                                  return;
                                }

                                updateDraft((config) =>
                                  upsertEncoderMapping(config, {
                                    controlId: selectedControl.id,
                                    layer: selectedLayer,
                                    encodedKey: lastObservedEncodedKey,
                                    source: "detected",
                                    verified: false,
                                  }),
                                );
                              }}
                              disabled={!lastObservedEncodedKey}
                            >
                              Использовать наблюдаемый сигнал
                            </button>

                            <button
                              type="button"
                              className="action-button action-button--small action-button--secondary"
                              onClick={() => {
                                if (!selectedEncoder) {
                                  return;
                                }

                                updateDraft((config) =>
                                  upsertEncoderMapping(config, {
                                    ...selectedEncoder,
                                    verified: true,
                                  }),
                                );
                              }}
                              disabled={
                                !selectedEncoder ||
                                !lastObservedEncodedKey ||
                                selectedEncoder.encodedKey !== lastObservedEncodedKey
                              }
                            >
                              Пометить сигнал как подтверждённый
                            </button>

                            <button
                              type="button"
                              className="action-button action-button--small action-button--secondary"
                              onClick={() => {
                                updateDraft((config) =>
                                  updateControlCapabilityStatus(
                                    config,
                                    selectedControl.id,
                                    selectedEncoder?.verified ? "verified" : "needsValidation",
                                  ),
                                );
                              }}
                              disabled={!selectedEncoder}
                            >
                              Повысить статус кнопки
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <p className="panel__muted">
                      Выберите кнопку перед сверкой ожидаемого, настроенного и
                      наблюдаемого сигнала.
                    </p>
                  )}
                </section>
              ) : null}

              {showRuntimePanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Фоновый перехват</p>
                  <div className="runtime-controls">
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => {
                        void handleStartRuntime();
                      }}
                      disabled={
                        isDirty ||
                        viewState === "loading" ||
                        viewState === "saving" ||
                        runtimeSummary.status === "running"
                      }
                    >
                      Запустить
                    </button>
                    <button
                      type="button"
                      className="action-button action-button--secondary"
                      onClick={() => {
                        void handleReloadRuntime();
                      }}
                      disabled={
                        isDirty ||
                        viewState === "loading" ||
                        viewState === "saving" ||
                        runtimeSummary.status !== "running"
                      }
                    >
                      Перезапустить
                    </button>
                    <button
                      type="button"
                      className="action-button action-button--secondary"
                      onClick={() => {
                        void handleStopRuntime();
                      }}
                      disabled={
                        viewState === "loading" ||
                        viewState === "saving" ||
                        runtimeSummary.status !== "running"
                      }
                    >
                      Остановить
                    </button>
                  </div>

                  <div className="fact-grid">
                    <Fact label="Состояние" value={labelForRuntimeStatus(runtimeSummary.status)} />
                    <Fact label="Бэкенд" value={runtimeSummary.captureBackend} />
                    <Fact
                      label="Версия конфигурации"
                      value={String(runtimeSummary.activeConfigVersion ?? "н/д")}
                    />
                    <Fact
                      label="Предупреждений"
                      value={String(runtimeSummary.warningCount)}
                    />
                    <Fact
                      label="Запущен"
                      value={formatTimestamp(runtimeSummary.startedAt)}
                    />
                    <Fact
                      label="Последняя перезагрузка"
                      value={formatTimestamp(runtimeSummary.lastReloadAt)}
                    />
                  </div>

                  {isDirty ? (
                    <div className="notice notice--warning">
                      <strong>Сначала сохраните изменения</strong>
                      <p>
                        Фоновый перехват использует сохранённую конфигурацию, а не
                        текущий черновик в памяти.
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {isExpertMode ? (
                <PanelGroup title="Служебные инструменты">
              {showWindowCapturePanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Захват активного окна</p>
                  <div className="editor-grid">
                    <label className="field">
                      <span className="field__label">Задержка</span>
                      <select
                        value={captureDelayMs}
                        onChange={(event) => {
                          setCaptureDelayMs(Number(event.target.value));
                        }}
                      >
                        <option value={0}>Без задержки</option>
                        <option value={1500}>1,5 секунды</option>
                        <option value={3000}>3 секунды</option>
                        <option value={5000}>5 секунд</option>
                      </select>
                    </label>

                    <button
                      type="button"
                      className="action-button"
                      onClick={() => {
                        void handleCaptureActiveWindow();
                      }}
                      disabled={viewState === "loading" || viewState === "saving"}
                    >
                      Захватить активное окно
                    </button>

                    {lastCapture ? (
                      <div className="fact-grid">
                        <Fact label="Исполняемый файл" value={lastCapture.exe} />
                        <Fact label="HWND" value={lastCapture.hwnd} />
                        <Fact
                          label="Выбранный профиль"
                          value={lastCapture.resolvedProfileId ?? "н/д"}
                        />
                        <Fact
                          label="Правило приложения"
                          value={lastCapture.matchedAppMappingId ?? "профиль по умолчанию"}
                        />
                        <Fact label="Заголовок" value={lastCapture.title || "(пусто)"} />
                        <Fact label="Причина" value={lastCapture.resolutionReason} />
                      </div>
                    ) : (
                      <p className="panel__muted">
                        Поставьте небольшую задержку, переключитесь в другое окно и
                        затем захватите его, чтобы проверить выбор профиля.
                      </p>
                    )}
                  </div>
                </section>
              ) : null}

              {showPreviewPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Проверка срабатывания</p>
                  <div className="editor-grid">
                    <label className="field">
                      <span className="field__label">Код сигнала</span>
                      <input
                        type="text"
                        value={resolutionKeyInput}
                        onChange={(event) => {
                          setResolutionKeyInput(event.target.value);
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      className="action-button"
                      onClick={() => {
                        void handlePreviewResolution();
                      }}
                      disabled={!resolutionKeyInput.trim()}
                    >
                      Проверить
                    </button>

                    <button
                      type="button"
                      className="action-button action-button--secondary"
                      onClick={() => {
                        void handleExecutePreviewAction();
                      }}
                      disabled={!resolutionKeyInput.trim()}
                    >
                      Пробный прогон
                    </button>

                    <button
                      type="button"
                      className="action-button action-button--secondary"
                      onClick={() => {
                        void handleRunPreviewAction();
                      }}
                      disabled={!canRunLiveAction}
                    >
                      Выполнить вживую
                    </button>

                    {lastEncodedKey ? (
                      <div className="fact-grid">
                        <Fact label="Сигнал" value={lastEncodedKey.encodedKey} />
                        <Fact label="Бэкенд" value={lastEncodedKey.backend} />
                        <Fact label="Получен" value={formatTimestamp(lastEncodedKey.receivedAt)} />
                      </div>
                    ) : null}

                    {lastResolutionPreview ? (
                      <div className="fact-grid">
                        <Fact label="Статус" value={labelForPreviewStatus(lastResolutionPreview.status)} />
                        <Fact
                          label="Профиль"
                          value={lastResolutionPreview.resolvedProfileId ?? "н/д"}
                        />
                        <Fact
                          label="Кнопка"
                          value={lastResolutionPreview.controlId ?? "н/д"}
                        />
                        <Fact
                          label="Слой"
                          value={lastResolutionPreview.layer ?? "н/д"}
                        />
                        <Fact
                          label="Назначение"
                          value={lastResolutionPreview.bindingId ?? "н/д"}
                        />
                        <Fact
                          label="Действие"
                          value={lastResolutionPreview.actionId ?? "н/д"}
                        />
                      </div>
                    ) : (
                      <p className="panel__muted">
                        Проверьте сигнал вроде <code>F13</code> или
                        <code> Ctrl+Alt+Shift+F13</code> на текущей конфигурации.
                      </p>
                    )}
                  </div>
                </section>
              ) : null}

              {showExecutionPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Выполнение действия</p>
                  {lastExecution ? (
                    <div className="editor-grid">
                      <div className="fact-grid">
                        <Fact label="Результат" value={labelForExecutionOutcome(lastExecution.outcome)} />
                        <Fact label="Режим" value={labelForExecutionMode(lastExecution.mode)} />
                        <Fact label="Действие" value={lastExecution.actionId} />
                        <Fact label="Профиль" value={lastExecution.resolvedProfileId ?? "н/д"} />
                        <Fact label="Кнопка" value={lastExecution.controlId ?? "н/д"} />
                        <Fact label="PID" value={String(lastExecution.processId ?? "н/д")} />
                        <Fact label="Когда" value={formatTimestamp(lastExecution.executedAt)} />
                      </div>

                      <p className="panel__muted">
                        {lastExecution.summary}
                        {" "}Название: {lastExecution.actionPretty} ({lastExecution.actionType}).
                      </p>

                      {lastExecution.warnings.map((warning) => (
                        <p className="panel__muted" key={warning}>
                          Предупреждение: {warning}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="panel__muted">
                      Запустите проверку действия, чтобы увидеть результат выполнения.
                    </p>
                  )}

                  {lastRuntimeError ? (
                    <div className="notice notice--error">
                      <strong>{lastRuntimeError.category}</strong>
                      <p>{lastRuntimeError.message}</p>
                      <p className="notice__meta">
                        Код сигнала: {lastRuntimeError.encodedKey ?? "н/д"}
                      </p>
                      <p className="notice__meta">
                        ID действия: {lastRuntimeError.actionId ?? "н/д"}
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {showDebugPanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Журнал событий</p>
                  {debugLog.length > 0 ? (
                    <ul className="log-list">
                      {[...debugLog].reverse().map((entry) => (
                        <li key={entry.id} className="log-item">
                          <span className={`badge ${logLevelBadgeClass(entry.level)}`}>
                            {entry.level}
                          </span>
                          <div className="log-item__body">
                            <strong>{entry.message}</strong>
                            <span>
                              {entry.category} · {formatTimestamp(entry.createdAt)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="panel__muted">
                      Журнал пока пуст. Запустите, перезапустите или остановите
                      фоновый перехват, чтобы увидеть события.
                    </p>
                  )}
                </section>
              ) : null}

              {showPersistencePanel ? (
                <section className="panel">
                  <p className="panel__eyebrow">Сохранение</p>
                  <p className="panel__path">{activePath}</p>
                  {lastSave?.backupPath ? (
                    <p className="panel__muted">
                      Последняя резервная копия: <code>{lastSave.backupPath}</code>
                    </p>
                  ) : null}
                  {error ? <ErrorPanel error={error} /> : null}
                  {!error && isDirty ? (
                    <div className="notice notice--info">
                      <strong>Есть несохранённые изменения</strong>
                      <p>
                        Текущее состояние редактора живёт только в памяти. Пока вы
                        не сохраните изменения, предупреждения ниже могут быть
                        устаревшими.
                      </p>
                    </div>
                  ) : null}
                  {!error && !isDirty && activeWarnings.length > 0 ? (
                    <WarningsPanel warnings={activeWarnings} />
                  ) : null}
                  {!error && !isDirty && activeWarnings.length === 0 ? (
                    <div className="notice notice--ok">
                      <strong>Предупреждений нет</strong>
                      <p>
                        Текущая сохранённая конфигурация прошла загрузку и
                        сохранение без предупреждений.
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {showSettingsPanel ? (
                <section className="panel panel--compact">
                  <p className="panel__eyebrow">Настройки приложения</p>
                  <div className="editor-grid">
                    <label className="field">
                      <span className="field__label">Профиль по умолчанию</span>
                      <select
                        value={activeConfig.settings.fallbackProfileId}
                        onChange={(event) => {
                          updateDraft((config) => ({
                            ...config,
                            settings: {
                              ...config.settings,
                              fallbackProfileId: event.target.value,
                            },
                          }));
                        }}
                      >
                        {profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} ({profile.id})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field__label">Тема</span>
                      <select
                        value={activeConfig.settings.theme}
                        onChange={(event) => {
                          updateDraft((config) => ({
                            ...config,
                            settings: {
                              ...config.settings,
                              theme: event.target.value,
                            },
                          }));
                        }}
                      >
                        <option value="dark">Тёмная</option>
                        <option value="razer">Razer Green</option>
                      </select>
                    </label>

                    <label className="field field--inline">
                      <span className="field__label">Запускать вместе с Windows</span>
                      <input
                        type="checkbox"
                        checked={activeConfig.settings.startWithWindows}
                        onChange={(event) => {
                          updateDraft((config) => ({
                            ...config,
                            settings: {
                              ...config.settings,
                              startWithWindows: event.target.checked,
                            },
                          }));
                        }}
                      />
                    </label>

                    <label className="field field--inline">
                      <span className="field__label">Сворачивать в трей</span>
                      <input
                        type="checkbox"
                        checked={activeConfig.settings.minimizeToTray}
                        onChange={(event) => {
                          updateDraft((config) => ({
                            ...config,
                            settings: {
                              ...config.settings,
                              minimizeToTray: event.target.checked,
                            },
                          }));
                        }}
                      />
                    </label>

                    <label className="field field--inline">
                      <span className="field__label">Отладочное логирование</span>
                      <input
                        type="checkbox"
                        checked={activeConfig.settings.debugLogging}
                        onChange={(event) => {
                          updateDraft((config) => ({
                            ...config,
                            settings: {
                              ...config.settings,
                              debugLogging: event.target.checked,
                            },
                          }));
                        }}
                      />
                    </label>
                  </div>
                </section>
              ) : null}
                </PanelGroup>
              ) : null}
            </div>
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
    </main>
  );
}

function PanelGroup({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="panel-group" open={defaultOpen || undefined}>
      <summary>{title}</summary>
      <div className="panel-group__body">{children}</div>
    </details>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WarningsPanel({ warnings }: { warnings: ValidationWarning[] }) {
  return (
    <div className="notice notice--warning">
      <strong>Предупреждения проверки</strong>
      <ul>
        {warnings.map((warning) => (
          <li key={`${warning.code}-${warning.path ?? warning.message}`}>
            <span>{warning.message}</span>
            {warning.path ? <code>{warning.path}</code> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ErrorPanel({ error }: { error: CommandError }) {
  return (
    <div className="notice notice--error">
      <strong>{error.code}</strong>
      <p>{error.message}</p>
      {error.details?.length ? (
        <ul>
          {error.details.map((detail) => (
            <li key={detail}>
              <code>{detail}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function resolveInitialProfileId(config: AppConfig): string | null {
  return (
    config.profiles.find((profile) => profile.id === config.settings.fallbackProfileId)?.id ??
    config.profiles[0]?.id ??
    null
  );
}

function resolveInitialControlId(config: AppConfig): ControlId | null {
  return (
    config.physicalControls.find((control) => control.family === "thumbGrid")?.id ??
    config.physicalControls[0]?.id ??
    null
  );
}


function sortAppMappings(mappings: AppMapping[]): AppMapping[] {
  return [...mappings].sort(
    (left, right) =>
      right.priority - left.priority || left.exe.localeCompare(right.exe),
  );
}

function parseCommaSeparatedUniqueValues(value: string): string[] {
  const seen = new Set<string>();

  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag)) {
        return false;
      }

      seen.add(tag);
      return true;
    });
}

function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCommaSeparatedTags(value: string): string[] {
  return parseCommaSeparatedUniqueValues(value);
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : undefined;
}


function getVisibleActions(
  actions: Action[],
  query: string,
  selectedActionId: string | null,
): Action[] {
  const normalizedQuery = query.trim().toLowerCase();
  const sortedActions = [...actions].sort(
    (left, right) =>
      left.pretty.localeCompare(right.pretty) || left.id.localeCompare(right.id),
  );

  if (!normalizedQuery) {
    return sortedActions;
  }

  const filteredActions = sortedActions.filter((action) =>
    [action.pretty, action.id, action.type, action.notes ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );

  if (
    selectedActionId &&
    !filteredActions.some((action) => action.id === selectedActionId)
  ) {
    const selectedAction = sortedActions.find((action) => action.id === selectedActionId);
    if (selectedAction) {
      return [selectedAction, ...filteredActions];
    }
  }

  return filteredActions;
}

function describeActionSummary(
  action: Action | null,
  snippetsById: Map<string, SnippetLibraryItem>,
): string {
  if (!action) {
    return "Предпросмотр действия отсутствует.";
  }

  if (action.type === "shortcut" && "key" in action.payload) {
    const modifiers = [
      action.payload.ctrl ? "Ctrl" : null,
      action.payload.shift ? "Shift" : null,
      action.payload.alt ? "Alt" : null,
      action.payload.win ? "Win" : null,
      action.payload.key,
    ].filter(Boolean);

    return `Шорткат: ${modifiers.join(" + ")}`;
  }

  if (action.type === "textSnippet" && "source" in action.payload) {
    if (action.payload.source === "libraryRef") {
      const snippet = snippetsById.get(action.payload.snippetId);
      return snippet
        ? `Фрагмент из библиотеки: ${snippet.name}`
        : `Ссылка на библиотеку фрагментов: ${action.payload.snippetId}`;
    }

    return `Встроенный фрагмент через ${labelForPasteMode(action.payload.pasteMode)}`;
  }

  if (action.type === "sequence" && "steps" in action.payload) {
    return `Последовательность из ${action.payload.steps.length} шаг(ов).`;
  }

  if (action.type === "launch" && "target" in action.payload) {
    return `Цель запуска: ${action.payload.target}`;
  }

  if (action.type === "menu" && "items" in action.payload) {
    return `Меню из ${action.payload.items.length} пункт(ов).`;
  }

  return action.notes ?? "Отключённое действие-заглушка.";
}

function describeVerificationAlignment(
  expectedEncodedKey: string | null,
  configuredEncodedKey: string | null,
  observedEncodedKey: string | null,
  observedMatchesSelectedControl: boolean,
): { title: string; body: string; noticeClass: string } {
  if (!expectedEncodedKey && !configuredEncodedKey) {
    return {
      title: "Namespace для проверки пока не задан",
      body: "Для этого контрола пока не задан ожидаемый encoded key. Считайте это ручной задачей на валидацию.",
      noticeClass: "notice--info",
    };
  }

  if (!configuredEncodedKey && expectedEncodedKey) {
    return {
      title: "Ожидаемый key известен, но ещё не настроен",
      body: `Создайте ожидаемый сигнал \`${expectedEncodedKey}\`, сохраните конфигурацию, запустите перехват и затем нажмите физическую кнопку для проверки.`,
      noticeClass: "notice--warning",
    };
  }

  if (
    expectedEncodedKey &&
    configuredEncodedKey &&
    expectedEncodedKey !== configuredEncodedKey
  ) {
    return {
      title: "Настроенный сигнал расходится с ожидаемым",
      body: `Сейчас конфигурация использует \`${configuredEncodedKey}\`, хотя план проверки ожидает \`${expectedEncodedKey}\`. Это может быть специально, но требует явного подтверждения.`,
      noticeClass: "notice--warning",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey === configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: "Наблюдаемый сигнал совпадает с настроенным",
      body: `Последнее событие перехвата сообщило \`${observedEncodedKey}\` для этой кнопки и слоя. Это сильный сигнал, что настройку можно пометить как подтверждённую.`,
      noticeClass: "notice--ok",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey !== configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: "Наблюдаемый сигнал отличается от настроенного",
      body: `Последнее событие перехвата сообщило \`${observedEncodedKey}\`, но конфигурация сейчас ожидает \`${configuredEncodedKey}\`. Сначала приведите сигнал в порядок, потом доверяйте живому выполнению.`,
      noticeClass: "notice--warning",
    };
  }

  return {
    title: "Настроенный сигнал готов к проверке",
    body: "Сохраните текущую конфигурацию, запустите перехват и нажмите выбранную физическую кнопку. Следующее событие покажет, воспроизводится ли сигнал.",
    noticeClass: "notice--subtle",
  };
}

function deriveVerificationSessionResult(
  step: VerificationSession["steps"][number] | null,
  preview: ResolvedInputPreview | null,
  selectedControlId: ControlId | null,
  selectedLayer: Layer,
): Exclude<VerificationStepResult, "pending"> | null {
  if (!step) {
    return null;
  }

  if (!step.observedEncodedKey) {
    return "noSignal";
  }

  if (
    step.configuredEncodedKey &&
    step.observedEncodedKey === step.configuredEncodedKey &&
    preview?.controlId === selectedControlId &&
    preview?.layer === selectedLayer
  ) {
    return "matched";
  }

  return "mismatched";
}

function describeVerificationSessionSuggestion(
  result: Exclude<VerificationStepResult, "pending">,
  step: VerificationSession["steps"][number],
): string {
  switch (result) {
    case "matched":
      return `Наблюдаемый сигнал \`${step.observedEncodedKey}\` совпал с настроенным и выглядит как корректное попадание в текущую кнопку.`;
    case "mismatched":
      return step.observedEncodedKey
        ? `Сейчас пришёл \`${step.observedEncodedKey}\`, но этого недостаточно для чистого совпадения с ожидаемой конфигурацией.`
        : "Наблюдение не дало чистого совпадения.";
    case "noSignal":
      return "После старта шага приложение пока не увидело нового сигнала. Проверьте runtime, сохранённую конфигурацию и саму кнопку.";
    case "skipped":
      return "Шаг пропущен пользователем.";
  }
}

function isActionLiveRunnable(config: AppConfig, actionId: string): boolean {
  const action = config.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    return false;
  }

  if (action.type === "shortcut") {
    return "key" in action.payload;
  }

  if (action.type === "textSnippet" && "source" in action.payload) {
    const payload = action.payload as TextSnippetPayload;
    if (payload.source === "inline") {
      return true;
    }

    const snippet = config.snippetLibrary.find(
      (candidate) => candidate.id === payload.snippetId,
    );
    return Boolean(snippet);
  }

  if (action.type === "sequence" && "steps" in action.payload) {
    return action.payload.steps.length > 0;
  }

  if (action.type === "launch") {
    return "target" in action.payload;
  }

  if (action.type === "disabled") {
    return true;
  }

  return false;
}

function withShortcutPayload(
  action: Action,
  updatePayload: (payload: ShortcutActionPayload) => ShortcutActionPayload,
): Action {
  if (action.type !== "shortcut" || !("key" in action.payload)) {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload as ShortcutActionPayload),
  };
}

function withTextSnippetPayload(
  action: Action,
  updatePayload: (payload: TextSnippetPayload) => TextSnippetPayload,
): Action {
  if (action.type !== "textSnippet" || !("source" in action.payload)) {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload as TextSnippetPayload),
  };
}

function withSequencePayload(
  action: Action,
  updatePayload: (payload: SequenceActionPayload) => SequenceActionPayload,
): Action {
  if (action.type !== "sequence" || !("steps" in action.payload)) {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload as SequenceActionPayload),
  };
}

function withLaunchPayload(
  action: Action,
  updatePayload: (payload: LaunchActionPayload) => LaunchActionPayload,
): Action {
  if (action.type !== "launch" || !("target" in action.payload)) {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload as LaunchActionPayload),
  };
}

function withMenuPayload(
  action: Action,
  updatePayload: (payload: MenuActionPayload) => MenuActionPayload,
): Action {
  if (action.type !== "menu" || !("items" in action.payload)) {
    return action;
  }

  return {
    ...action,
    payload: updatePayload(action.payload as MenuActionPayload),
  };
}

function createDefaultSequenceStep(stepType: SequenceStep["type"]): SequenceStep {
  switch (stepType) {
    case "send":
      return { type: "send", value: "Ctrl+C" };
    case "text":
      return { type: "text", value: "Replace me" };
    case "sleep":
      return { type: "sleep", delayMs: 100 };
    case "launch":
      return { type: "launch", value: "C:\\Path\\To\\App.exe" };
  }
}

function coerceSequenceStepType(
  step: SequenceStep,
  nextType: SequenceStep["type"],
): SequenceStep {
  if (step.type === nextType) {
    return step;
  }

  switch (nextType) {
    case "send":
      return {
        type: "send",
        value: "value" in step ? step.value : "Ctrl+C",
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "text":
      return {
        type: "text",
        value: "value" in step ? step.value : "Replace me",
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
    case "sleep":
      return {
        type: "sleep",
        delayMs: "delayMs" in step ? step.delayMs ?? 100 : 100,
      };
    case "launch":
      return {
        type: "launch",
        value: "value" in step ? step.value : "C:\\Path\\To\\App.exe",
        args: step.type === "launch" ? step.args : undefined,
        workingDir: step.type === "launch" ? step.workingDir : undefined,
        delayMs: "delayMs" in step ? step.delayMs : undefined,
      };
  }
}

function setSequenceStepDelay(
  step: SequenceStep,
  nextDelay: number | undefined,
): SequenceStep {
  if (step.type === "sleep") {
    return {
      ...step,
      delayMs: nextDelay ?? 0,
    };
  }

  return {
    ...step,
    delayMs: nextDelay,
  };
}

function collectMenuItemIds(items: MenuItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "submenu"
      ? [item.id, ...collectMenuItemIds(item.items)]
      : [item.id],
  );
}

function appendMenuItem(
  items: MenuItem[],
  parentId: string | null,
  nextItem: MenuItem,
): MenuItem[] {
  if (parentId === null) {
    return [...items, nextItem];
  }

  return items.map((item) => {
    if (item.kind === "submenu") {
      if (item.id === parentId) {
        return {
          ...item,
          items: [...item.items, nextItem],
        };
      }

      return {
        ...item,
        items: appendMenuItem(item.items, parentId, nextItem),
      };
    }

    return item;
  });
}

function updateMenuItem(
  items: MenuItem[],
  targetId: string,
  updateItem: (item: MenuItem) => MenuItem,
): MenuItem[] {
  return items.map((item) => {
    if (item.id === targetId) {
      return updateItem(item);
    }

    if (item.kind === "submenu") {
      return {
        ...item,
        items: updateMenuItem(item.items, targetId, updateItem),
      };
    }

    return item;
  });
}

function removeMenuItem(items: MenuItem[], targetId: string): MenuItem[] {
  return items
    .filter((item) => item.id !== targetId)
    .map((item) =>
      item.kind === "submenu"
        ? {
            ...item,
            items: removeMenuItem(item.items, targetId),
          }
        : item,
    );
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) {
    return "н/д";
  }

  return new Date(timestamp).toLocaleString();
}

function logLevelBadgeClass(level: DebugLogEntry["level"]): string {
  switch (level) {
    case "info":
      return "badge--info";
    case "warn":
      return "badge--warn";
  }
}

function labelForControlFamily(family: ControlFamily): string {
  switch (family) {
    case "thumbGrid":
      return "Боковая клавиатура";
    case "topPanel":
      return "Верхняя панель";
    case "wheel":
      return "Колесо";
    case "system":
      return "Системные контролы";
  }
}

function labelForEncoderSource(source: EncoderMapping["source"] | undefined): string {
  switch (source) {
    case "synapse":
      return "Synapse";
    case "detected":
      return "Обнаружен";
    case "reserved":
      return "Зарезервирован";
    default:
      return "н/д";
  }
}

function labelForRuntimeStatus(status: RuntimeStateSummary["status"]): string {
  return status === "running" ? "Запущен" : "Остановлен";
}

function labelForPreviewStatus(status: ResolvedInputPreview["status"]): string {
  switch (status) {
    case "resolved":
      return "Найдено";
    case "unresolved":
      return "Не найдено";
    case "ambiguous":
      return "Неоднозначно";
    default:
      return status;
  }
}

function labelForExecutionOutcome(outcome: ActionExecutionEvent["outcome"]): string {
  switch (outcome) {
    case "spawned":
      return "Запущено";
    case "injected":
      return "Отправлено";
    case "simulated":
      return "Смоделировано";
    case "noop":
      return "Без действия";
    default:
      return outcome;
  }
}

function labelForExecutionMode(mode: ActionExecutionEvent["mode"]): string {
  return mode === "live" ? "Живой" : "Пробный";
}

function labelForPasteMode(mode: PasteMode): string {
  return mode === "clipboardPaste" ? "буфер обмена" : "прямой ввод";
}

function labelForSequenceStep(stepType: SequenceStep["type"]): string {
  switch (stepType) {
    case "send":
      return "Отправка сочетания";
    case "text":
      return "Ввод текста";
    case "sleep":
      return "Пауза";
    case "launch":
      return "Запуск";
  }
}

function badgeClassForCapability(status: PhysicalControl["capabilityStatus"]): string {
  switch (status) {
    case "verified": return "badge--ok";
    case "needsValidation": return "badge--warn";
    case "reserved": return "badge--muted";
    case "partiallyRemappable": return "badge--info";
  }
}

function labelForCapability(controlStatus: PhysicalControl["capabilityStatus"]): string {
  switch (controlStatus) {
    case "verified":
      return "Подтверждён";
    case "needsValidation":
      return "Нужна проверка";
    case "reserved":
      return "Зарезервирован";
    case "partiallyRemappable":
      return "Частично";
  }
}

function labelForLayer(layer: Layer): string {
  return layer === "standard" ? "Стандартный" : "Hypershift";
}

function labelForVerificationResult(result: VerificationStepResult): string {
  switch (result) {
    case "pending":
      return "Ожидает";
    case "matched":
      return "Совпало";
    case "mismatched":
      return "Не совпало";
    case "noSignal":
      return "Нет сигнала";
    case "skipped":
      return "Пропущено";
  }
}

function stateLabel(viewState: ViewState): string {
  switch (viewState) {
    case "idle":
      return "Ожидание";
    case "loading":
      return "Загрузка конфигурации";
    case "ready":
      return "Готово";
    case "saving":
      return "Сохранение";
    case "error":
      return "Ошибка";
  }
}

export default App;
