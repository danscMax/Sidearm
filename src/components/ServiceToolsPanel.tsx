import type {
  AppConfig,
  CommandError,
  Profile,
  ValidationWarning,
} from "../lib/config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  EncodedKeyEvent,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  WindowCaptureResult,
} from "../lib/runtime";
import type { ViewState } from "../lib/constants";
import { controlName } from "../lib/helpers";
import {
  formatTimestamp,
  labelForExecutionMode,
  labelForExecutionOutcome,
  labelForPreviewStatus,
} from "../lib/labels";
import { isActionLiveRunnable } from "../lib/action-helpers";
import { LogPanel } from "./LogPanel";
import { Fact, PanelGroup, WarningsPanel, ErrorPanel } from "./shared";
import type { LogPanelControl } from "../hooks/useLogPanel";
import { useTranslation } from "react-i18next";

export interface ServiceToolsPanelProps {
  activeConfig: AppConfig;
  profiles: Profile[];

  viewState: ViewState;
  activePath: string;
  activeWarnings: ValidationWarning[];
  lastSave: { backupPath?: string } | null;
  error: CommandError | null;
  captureDelayMs: number;
  setCaptureDelayMs: (ms: number) => void;
  lastCapture: WindowCaptureResult | null;
  lastEncodedKey: EncodedKeyEvent | null;
  resolutionKeyInput: string;
  setResolutionKeyInput: (value: string) => void;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  debugLog: DebugLogEntry[];
  logPanel: LogPanelControl;
  handleCaptureActiveWindow: () => Promise<void>;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
}

export function ServiceToolsPanel({
  activeConfig,
  profiles,
  viewState,
  activePath,
  activeWarnings,
  lastSave,
  error,
  captureDelayMs,
  setCaptureDelayMs,
  lastCapture,
  lastEncodedKey,
  resolutionKeyInput,
  setResolutionKeyInput,
  lastResolutionPreview,
  lastExecution,
  lastRuntimeError,
  logPanel,
  handleCaptureActiveWindow,
  handlePreviewResolution,
  handleExecutePreviewAction,
  handleRunPreviewAction,
  updateDraft,
}: ServiceToolsPanelProps) {
  const { t } = useTranslation();
  const resolvedLiveRunnable =
    lastResolutionPreview?.actionId
      ? isActionLiveRunnable(activeConfig, lastResolutionPreview.actionId)
      : false;
  const canRunLiveAction =
    lastResolutionPreview?.status === "resolved" &&
    resolvedLiveRunnable;

  return (
    <PanelGroup title={t("serviceTools.panelTitle")} defaultOpen>
      <section className="panel">
        <p className="panel__eyebrow">{t("serviceTools.captureTitle")}</p>
        <div className="editor-grid">
          <label className="field">
            <span className="field__label">{t("serviceTools.delayLabel")}</span>
            <select
              value={captureDelayMs}
              onChange={(event) => {
                setCaptureDelayMs(Number(event.target.value));
              }}
            >
              <option value={0}>{t("serviceTools.delayNone")}</option>
              <option value={1500}>{t("serviceTools.delay1500")}</option>
              <option value={3000}>{t("serviceTools.delay3000")}</option>
              <option value={5000}>{t("serviceTools.delay5000")}</option>
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
            {t("serviceTools.captureButton")}
          </button>

          {lastCapture ? (
            <div className="fact-grid">
              <Fact label={t("newRule.exe")} value={lastCapture.exe} mono />
              <Fact label={t("serviceTools.hwndLabel")} value={lastCapture.hwnd} mono />
              <Fact
                label={t("serviceTools.resolvedProfileLabel")}
                value={lastCapture.resolvedProfileId ?? t("common.na")}
              />
              <Fact
                label={t("serviceTools.appMappingLabel")}
                value={lastCapture.matchedAppMappingId ?? t("serviceTools.defaultProfileFallback")}
              />
              <Fact label={t("serviceTools.windowTitleLabel")} value={lastCapture.title || t("serviceTools.emptyValue")} />
              <Fact label={t("serviceTools.resolutionReasonLabel")} value={lastCapture.resolutionReason} />
              {lastCapture.isElevated && (
                <p className="panel__warning">
                  {t("serviceTools.elevatedWarning")}
                </p>
              )}
            </div>
          ) : (
            <p className="panel__muted">
              {t("serviceTools.captureHint")}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <p className="panel__eyebrow">{t("serviceTools.resolutionTitle")}</p>
        <div className="editor-grid">
          <label className="field">
            <span className="field__label">{t("serviceTools.signalCodeLabel")}</span>
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
            {t("debug.check")}
          </button>

          <button
            type="button"
            className="action-button action-button--secondary"
            onClick={() => {
              void handleExecutePreviewAction();
            }}
            disabled={!resolutionKeyInput.trim()}
          >
            {t("serviceTools.dryRunButton")}
          </button>

          <button
            type="button"
            className="action-button action-button--warning"
            onClick={() => {
              void handleRunPreviewAction();
            }}
            disabled={!canRunLiveAction}
          >
            {t("serviceTools.runLiveButton")}
          </button>

          {lastEncodedKey ? (
            <div className="fact-grid">
              <Fact label={t("serviceTools.signalLabel")} value={lastEncodedKey.encodedKey} mono />
              <Fact label={t("runtime.backend")} value={lastEncodedKey.backend} mono />
              <Fact label={t("serviceTools.receivedAtLabel")} value={formatTimestamp(lastEncodedKey.receivedAt)} />
            </div>
          ) : null}

          {lastResolutionPreview ? (
            <div className="fact-grid">
              <Fact label={t("serviceTools.statusLabel")} value={labelForPreviewStatus(lastResolutionPreview.status)} />
              {lastResolutionPreview.reason ? (
                <Fact label={t("serviceTools.resolutionReasonLabel")} value={lastResolutionPreview.reason} />
              ) : null}
              <Fact
                label={t("debug.profile")}
                value={
                  lastResolutionPreview.resolvedProfileId
                    ? (profiles.find((p) => p.id === lastResolutionPreview.resolvedProfileId)?.name ??
                        lastResolutionPreview.resolvedProfileId)
                    : t("common.na")
                }
              />
              <Fact
                label={t("debug.control")}
                value={
                  lastResolutionPreview.controlId
                    ? controlName(activeConfig.physicalControls, lastResolutionPreview.controlId)
                    : t("common.na")
                }
              />
              <Fact
                label={t("serviceTools.layerLabel")}
                value={lastResolutionPreview.layer ?? t("common.na")}
                mono
              />
              <Fact
                label={t("serviceTools.bindingLabel")}
                value={lastResolutionPreview.bindingId ?? t("common.na")}
                mono
              />
              <Fact
                label={t("debug.action")}
                value={lastResolutionPreview.actionId ?? t("common.na")}
                mono
              />
            </div>
          ) : (
            <p className="panel__muted">
              {t("serviceTools.resolutionHint")}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <p className="panel__eyebrow">{t("serviceTools.executionTitle")}</p>
        {lastExecution ? (
          <div className="editor-grid">
            <div className="fact-grid">
              <Fact label={t("debug.result")} value={labelForExecutionOutcome(lastExecution.outcome)} />
              <Fact label={t("debug.mode")} value={labelForExecutionMode(lastExecution.mode)} />
              <Fact label={t("debug.action")} value={lastExecution.actionId} />
              <Fact label={t("debug.profile")} value={lastExecution.resolvedProfileId ?? t("common.na")} />
              <Fact label={t("debug.control")} value={lastExecution.controlId ?? t("common.na")} />
              <Fact label={t("serviceTools.pidLabel")} value={String(lastExecution.processId ?? t("common.na"))} />
              <Fact label={t("serviceTools.executedAtLabel")} value={formatTimestamp(lastExecution.executedAt)} />
            </div>

            <p className="panel__muted">
              {lastExecution.summary}
              {" "}{t("serviceTools.executionName", { name: lastExecution.actionPretty, type: lastExecution.actionType })}
            </p>

            {lastExecution.warnings.map((warning) => (
              <p className="panel__muted" key={warning}>
                {t("serviceTools.warningPrefix", { text: warning })}
              </p>
            ))}
          </div>
        ) : (
          <p className="panel__muted">
            {t("serviceTools.executionHint")}
          </p>
        )}

        {lastRuntimeError ? (
          <div className="notice notice--error">
            <strong>{lastRuntimeError.category}</strong>
            <p>{lastRuntimeError.message}</p>
            <p className="notice__meta">
              {t("serviceTools.signalCodeLabel")}: {lastRuntimeError.encodedKey ?? t("common.na")}
            </p>
            <p className="notice__meta">
              {t("serviceTools.actionIdLabel")}: {lastRuntimeError.actionId ?? t("common.na")}
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <p className="panel__eyebrow">{t("debug.logTitle")}</p>
        <LogPanel logPanel={logPanel} />
      </section>

      <section className="panel">
        <p className="panel__eyebrow">{t("viewState.saving")}</p>
        <p className="panel__path">{activePath}</p>
        {lastSave?.backupPath ? (
          <p className="panel__muted">
            {t("serviceTools.lastBackupLabel")} <code>{lastSave.backupPath}</code>
          </p>
        ) : null}
        {error ? <ErrorPanel error={error} /> : null}
        {!error && activeWarnings.length > 0 ? (
          <WarningsPanel warnings={activeWarnings} />
        ) : null}
        {!error && activeWarnings.length === 0 ? (
          <div className="notice notice--ok">
            <strong>{t("serviceTools.noWarningsTitle")}</strong>
            <p>
              {t("serviceTools.noWarningsBody")}
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel panel--compact">
        <p className="panel__eyebrow">{t("serviceTools.appSettingsTitle")}</p>
        <div className="editor-grid">
          <label className="field">
            <span className="field__label">{t("serviceTools.fallbackProfileLabel")}</span>
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
            <span className="field__label">{t("serviceTools.themeLabel")}</span>
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
              <option value="dark">{t("serviceTools.themeDark")}</option>
              <option value="razer">{t("serviceTools.themeRazer")}</option>
            </select>
          </label>

          <label className="field field--inline">
            <span className="field__label">{t("serviceTools.minimizeToTray")}</span>
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
            <span className="field__label">{t("serviceTools.debugLogging")}</span>
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
    </PanelGroup>
  );
}
