import type {
  Action,
  AppConfig,
  Binding,
  CommandError,
  EncoderMapping,
  Layer,
  PhysicalControl,
  Profile,
  SnippetLibraryItem,
  ValidationWarning,
} from "../lib/config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  EncodedKeyEvent,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  RuntimeStateSummary,
  WindowCaptureResult,
} from "../lib/runtime";
import type { ViewState } from "../lib/constants";

import { ActionInspector } from "./ActionInspector";
import { SnippetLibraryEditor } from "./SnippetLibraryEditor";
import { ControlPropertiesPanel } from "./ControlPropertiesPanel";
import { RuntimePanel } from "./RuntimePanel";
import { ServiceToolsPanel } from "./ServiceToolsPanel";

export interface ExpertWorkspaceProps {
  activeConfig: AppConfig;
  profiles: Profile[];
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  snippetById: Map<string, SnippetLibraryItem>;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  // Runtime state
  runtimeSummary: RuntimeStateSummary;
  debugLog: DebugLogEntry[];
  captureDelayMs: number;
  setCaptureDelayMs: (ms: number) => void;
  lastCapture: WindowCaptureResult | null;
  lastEncodedKey: EncodedKeyEvent | null;
  resolutionKeyInput: string;
  setResolutionKeyInput: (value: string) => void;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  // Runtime handlers
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;
  handleCaptureActiveWindow: () => Promise<void>;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
  // Persistence state
  viewState: ViewState;
  activePath: string;
  activeWarnings: ValidationWarning[];
  lastSave: { backupPath?: string } | null;
  error: CommandError | null;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
}

export function ExpertWorkspace(props: ExpertWorkspaceProps) {
  const {
    activeConfig,
    profiles,
    selectedLayer,
    selectedControl,
    selectedBinding,
    selectedAction,
    selectedEncoder,
    snippetById,
    updateDraft,
    runtimeSummary,
    debugLog,
    captureDelayMs,
    setCaptureDelayMs,
    lastCapture,
    lastEncodedKey,
    resolutionKeyInput,
    setResolutionKeyInput,
    lastResolutionPreview,
    lastExecution,
    lastRuntimeError,
    handleStartRuntime,
    handleReloadRuntime,
    handleStopRuntime,
    handleCaptureActiveWindow,
    handlePreviewResolution,
    handleExecutePreviewAction,
    handleRunPreviewAction,
    viewState,
    activePath,
    activeWarnings,
    lastSave,
    error,
    setError,
  } = props;

  // --- Derived values ---
  const selectedActionUsageCount =
    selectedBinding
      ? activeConfig.bindings.filter(
          (binding) => binding.actionRef === selectedBinding.actionRef,
        ).length
      : 0;

  return (
    <>
      <div className="workspace__left">
        <ActionInspector
          activeConfig={activeConfig}
          selectedAction={selectedAction}
          snippetById={snippetById}
          selectedActionUsageCount={selectedActionUsageCount}
          updateDraft={updateDraft}
        />

        <SnippetLibraryEditor
          activeConfig={activeConfig}
          selectedAction={selectedAction}
          snippetById={snippetById}
          updateDraft={updateDraft}
        />
      </div>

      <div className="workspace__right">
        <ControlPropertiesPanel
          selectedLayer={selectedLayer}
          selectedControl={selectedControl}
          selectedBinding={selectedBinding}
          selectedAction={selectedAction}
          selectedEncoder={selectedEncoder}
          snippetById={snippetById}
          updateDraft={updateDraft}
        />

        <RuntimePanel
          runtimeSummary={runtimeSummary}
          viewState={viewState}
          handleStartRuntime={handleStartRuntime}
          handleReloadRuntime={handleReloadRuntime}
          handleStopRuntime={handleStopRuntime}
        />

        <ServiceToolsPanel
          activeConfig={activeConfig}
          profiles={profiles}
          viewState={viewState}
          activePath={activePath}
          activeWarnings={activeWarnings}
          lastSave={lastSave}
          error={error}
          captureDelayMs={captureDelayMs}
          setCaptureDelayMs={setCaptureDelayMs}
          lastCapture={lastCapture}
          lastEncodedKey={lastEncodedKey}
          resolutionKeyInput={resolutionKeyInput}
          setResolutionKeyInput={setResolutionKeyInput}
          lastResolutionPreview={lastResolutionPreview}
          lastExecution={lastExecution}
          lastRuntimeError={lastRuntimeError}
          debugLog={debugLog}
          handleCaptureActiveWindow={handleCaptureActiveWindow}
          handlePreviewResolution={handlePreviewResolution}
          handleExecutePreviewAction={handleExecutePreviewAction}
          handleRunPreviewAction={handleRunPreviewAction}
          updateDraft={updateDraft}
          setError={setError}
        />
      </div>
    </>
  );
}
