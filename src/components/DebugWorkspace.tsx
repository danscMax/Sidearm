import { useTranslation } from "react-i18next";
import type {
  Action,
  AppConfig,
  Binding,
  EncoderMapping,
  Layer,
  PhysicalControl,
  Profile,
  SnippetLibraryItem,
} from "../lib/config";
import type {
  ActionExecutionEvent,
  DebugLogEntry,
  EncodedKeyEvent,
  ExecutionRecord,
  ResolvedInputPreview,
  RuntimeErrorEvent,
  RuntimeStateSummary,
} from "../lib/runtime";
import type {
  VerificationSession,
  VerificationSessionScope,
  VerificationSessionStep,
  VerificationSessionSummary,
  VerificationStepResult,
} from "../lib/verification-session";
import { verificationScopeCopy } from "../lib/constants";
import {
  displayNameForControl,
  formatTimestamp,
  labelForExecutionMode,
  labelForExecutionOutcome,
  labelForPreviewStatus,
  labelForVerificationResult,
} from "../lib/labels";
import {
  controlPhysicalHintFor,
  describeVerificationSessionSuggestion,
  dotLabel,
  verificationResultColor,
} from "../lib/verification-helpers";
import { isActionLiveRunnable } from "../lib/action-helpers";

import { ControlPropertiesPanel } from "./ControlPropertiesPanel";
import { LogPanel } from "./LogPanel";
import { Fact, Notice, SelectField } from "./shared";
import type { LogPanelControl } from "../hooks/useLogPanel";

interface DebugRuntimeProps {
  debugLog: DebugLogEntry[];
  resolutionKeyInput: string;
  setResolutionKeyInput: (value: string) => void;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  lastEncodedKey: EncodedKeyEvent | null;
  selectedControlHistory?: ExecutionRecord[];
  runtimeSummary: RuntimeStateSummary;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
}

interface DebugVerificationProps {
  session: VerificationSession | null;
  scope: VerificationSessionScope;
  setScope: (scope: VerificationSessionScope) => void;
  lastExportPath: string | null;
  sessionSummary: VerificationSessionSummary;
  currentStep: VerificationSessionStep | null;
  suggestedResult: Exclude<VerificationStepResult, "pending"> | null;
  hasResults: boolean;
  handleStart: () => Promise<void>;
  handleRestartStep: () => void;
  handleResult: (result: Exclude<VerificationStepResult, "pending">) => void;
  handleNotesChange: (notes: string) => void;
  handleNavigateStep: (index: number) => void;
  handleReopenStep: (index: number) => void;
  handleReset: () => void;
  handleExport: () => Promise<void>;
}

export interface DebugWorkspaceProps {
  activeConfig: AppConfig;
  profiles: Profile[];
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  snippetById: Map<string, SnippetLibraryItem>;
  selectedLayer: Layer;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  logPanel: LogPanelControl;
  runtime: DebugRuntimeProps;
  verification: DebugVerificationProps;
}

export function DebugWorkspace(props: DebugWorkspaceProps) {
  const { t } = useTranslation();
  const {
    activeConfig,
    profiles,
    selectedControl,
    selectedBinding,
    selectedAction,
    selectedEncoder,
    snippetById,
    selectedLayer,
    updateDraft,
    logPanel,
    runtime,
    verification,
  } = props;

  const {
    resolutionKeyInput,
    setResolutionKeyInput,
    lastResolutionPreview,
    lastExecution,
    lastRuntimeError,
    lastEncodedKey,
    selectedControlHistory,
    runtimeSummary,
    handlePreviewResolution,
    handleExecutePreviewAction,
    handleRunPreviewAction,
  } = runtime;

  const {
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
  } = verification;

  const resolvedLiveRunnable =
    lastResolutionPreview?.actionId
      ? isActionLiveRunnable(activeConfig, lastResolutionPreview.actionId)
      : false;
  const canRunLiveAction =
    lastResolutionPreview?.status === "resolved" && resolvedLiveRunnable;

  return (
    <div className="expert-layout">
      {/* ── Testing toolbar ── */}
      <div className="debug-testing">
        <div className="debug-testing__bar">
          <input
            type="text"
            className="debug-testing__input"
            value={resolutionKeyInput}
            onChange={(event) => {
              setResolutionKeyInput(event.target.value);
            }}
            placeholder={t("debug.signalPlaceholder")}
            title={t("debug.signalTooltip")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && resolutionKeyInput.trim()) {
                void handlePreviewResolution();
              }
            }}
          />
          <div className="debug-testing__actions">
            <button
              type="button"
              className="action-button action-button--accent"
              onClick={() => { void handlePreviewResolution(); }}
              disabled={!resolutionKeyInput.trim()}
              title={t("debug.checkTooltip")}
            >
              {t("debug.check")}
            </button>
            <button
              type="button"
              className="action-button action-button--secondary"
              onClick={() => { void handleExecutePreviewAction(); }}
              disabled={!resolutionKeyInput.trim()}
              title={t("debug.testTooltip")}
            >
              {t("debug.test")}
            </button>
            <button
              type="button"
              className="action-button action-button--warning"
              onClick={() => { void handleRunPreviewAction(); }}
              disabled={!canRunLiveAction}
              title={t("debug.liveTooltip")}
            >
              {t("debug.live")}
            </button>
          </div>
        </div>
        <p className="panel__muted help-caption">
          {t("debug.helpTesting")}
        </p>

        {lastResolutionPreview ? (
          <div className="fact-grid mt-10">
            <Fact
              label={t("debug.profile")}
              value={lastResolutionPreview.resolvedProfileId
                ? (profiles.find((p) => p.id === lastResolutionPreview.resolvedProfileId)?.name ??
                    lastResolutionPreview.resolvedProfileId)
                : t("common.na")}
            />
            <Fact
              label={t("debug.control")}
              value={(() => {
                const cid = lastResolutionPreview.controlId;
                if (!cid) return t("common.na");
                const control = activeConfig.physicalControls.find((c) => c.id === cid);
                return control ? displayNameForControl(control, "raw") : cid;
              })()}
            />
            <Fact label={t("debug.result")} value={labelForPreviewStatus(lastResolutionPreview.status)} />
            {lastResolutionPreview.actionId ? (
              // Show the action's human name when it resolves; raw mono id only
              // as a fallback for dangling references.
              (() => {
                const name = activeConfig.actions.find(
                  (a) => a.id === lastResolutionPreview.actionId,
                )?.displayName;
                return (
                  <Fact
                    label={t("debug.action")}
                    value={name ?? lastResolutionPreview.actionId ?? ""}
                    mono={!name}
                  />
                );
              })()
            ) : null}
          </div>
        ) : null}

        {lastExecution ? (
          <div className="fact-grid mt-8">
            <Fact label={t("debug.outcome")} value={labelForExecutionOutcome(lastExecution.outcome)} />
            <Fact label={t("debug.mode")} value={labelForExecutionMode(lastExecution.mode)} />
            {(() => {
              const name = activeConfig.actions.find((a) => a.id === lastExecution.actionId)?.displayName;
              return (
                <Fact
                  label={t("debug.action")}
                  value={name ?? lastExecution.actionId}
                  mono={!name}
                />
              );
            })()}
            <Fact label={t("debug.time")} value={formatTimestamp(lastExecution.executedAt)} />
          </div>
        ) : null}

        {lastRuntimeError ? (
          <Notice variant="error" className="mt-10" title={t("debug.lastRuntimeError")}>
            <strong>{lastRuntimeError.category}</strong>
            <p>{lastRuntimeError.message}</p>
          </Notice>
        ) : null}
      </div>

      {/* ── Properties panel (full width) ── */}
      <div className="expert-section">
        <ControlPropertiesPanel
          selectedControl={selectedControl}
          selectedBinding={selectedBinding}
          selectedAction={selectedAction}
          selectedEncoder={selectedEncoder}
          snippetById={snippetById}
          selectedLayer={selectedLayer}
          lastEncodedKey={lastEncodedKey}
          lastResolutionPreview={lastResolutionPreview}
          executionHistory={selectedControlHistory}
          updateDraft={updateDraft}
          verificationSessionActive={!!verificationSession}
        />
      </div>

      {/* ── Collapsible verification session ── */}
      <details className="expert-log">
        <summary className="expert-log__summary">
          {t("debug.sessionTitle")}
          {verificationSession ? (
            <span className="expert-log__count">
              {" "}({sessionSummary.matched + sessionSummary.mismatched + sessionSummary.noSignal + sessionSummary.skipped}
              /{verificationSession.steps.length})
            </span>
          ) : null}
        </summary>
        <p className="panel__muted section-help">
          {t("debug.sessionHelp")}
        </p>
        <div className="expert-section">
          {selectedControl ? (
            <div className="editor-grid">
              <div className="compound-card">
                {/* Session setup (pre-start) */}
                {!verificationSession ? (
                  <>
                    <div className="compound-card__header">
                      <div>
                        <strong>{t("debug.sessionTitle")}</strong>
                        <span className="compound-card__meta">
                          {t("debug.sessionSetupMeta")}
                        </span>
                      </div>
                      <SelectField
                        className="verification-session__scope"
                        label={t("debug.scopeLabel")}
                        value={verificationScope}
                        onChange={(value) => setVerificationScope(value)}
                        options={verificationScopeCopy.map((scope) => ({
                          value: scope.value,
                          label: t(scope.label),
                        }))}
                      />
                    </div>

                    <p className="panel__muted">
                      {(() => {
                        const bodyKey = verificationScopeCopy.find(
                          (scope) => scope.value === verificationScope,
                        )?.body;
                        return bodyKey ? t(bodyKey) : "";
                      })()}
                    </p>

                    <div className="editor-actions">
                      <button
                        type="button"
                        className="action-button action-button--accent"
                        onClick={() => {
                          void handleStartVerificationSession();
                        }}
                      >
                        {runtimeSummary.status !== "running"
                          ? t("debug.startWithInterception")
                          : t("debug.startSession")}
                      </button>
                    </div>
                  </>
                ) : null}

                {/* Active session: progress + steps */}
                {verificationSession ? (
                  <>
                    <div className="verification-progress">
                      <div className="verification-progress__header">
                        <strong>
                          {t("debug.stepProgress", {
                            current: Math.min(verificationSession.activeStepIndex + 1, verificationSession.steps.length),
                            total: verificationSession.steps.length,
                          })}
                        </strong>
                        <span className="verification-progress__stats">
                          {sessionSummary.matched > 0 ? `${sessionSummary.matched} ✓` : null}
                          {sessionSummary.mismatched > 0 ? ` ${sessionSummary.mismatched} ✗` : null}
                          {sessionSummary.skipped > 0 ? ` ${sessionSummary.skipped} ⊘` : null}
                        </span>
                      </div>
                      <div className="verification-progress__bar">
                        {verificationSession.steps.map((step, index) => (
                          <button
                            key={step.controlId}
                            type="button"
                            className={`verification-progress__dot${
                              index === verificationSession.activeStepIndex
                                ? " verification-progress__dot--active"
                                : ""
                            }`}
                            ref={(el) => {
                              if (!el) return;
                              // CSP-safe: result tint via CSSOM, not inline style (P2-3).
                              if (index === verificationSession.activeStepIndex) {
                                el.style.removeProperty("background-color");
                              } else {
                                el.style.setProperty(
                                  "background-color",
                                  verificationResultColor(step.result),
                                );
                              }
                            }}
                            title={`${step.controlLabel}: ${labelForVerificationResult(step.result)}`}
                            onClick={() => {
                              handleNavigateVerificationStep(index);
                            }}
                          >
                            {dotLabel(step.controlId)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Current step instruction */}
                    {currentVerificationStep ? (
                      <div className="editor-grid">
                        <div className="verification-instruction">
                          <h3 className="verification-instruction__title">
                            {t("debug.pressButton", { label: currentVerificationStep.controlLabel })}
                          </h3>
                          <p className="verification-instruction__hint">
                            {controlPhysicalHintFor(currentVerificationStep.controlId) ??
                              t("debug.unknownHint")}
                          </p>
                        </div>

                        {currentVerificationStep.result !== "pending" ? (
                          <Notice variant="info">
                            <strong>
                              {t("debug.stepAlreadyDone", { result: labelForVerificationResult(currentVerificationStep.result) })}
                            </strong>
                            <p>
                              {t("debug.canRecheckOrSkip")}
                            </p>
                            <div className="editor-actions mt-8">
                              <button
                                type="button"
                                className="action-button action-button--small"
                                onClick={() => {
                                  handleReopenVerificationStep(verificationSession.activeStepIndex);
                                }}
                              >
                                {t("debug.recheck")}
                              </button>
                            </div>
                          </Notice>
                        ) : (
                          <>
                            <div className="fact-grid">
                              <Fact
                                label={t("debug.expectedLabel")}
                                value={currentVerificationStep.expectedEncodedKey ?? t("common.na")}
                              />
                              <Fact
                                label={t("debug.configuredLabel")}
                                value={currentVerificationStep.configuredEncodedKey ?? t("debug.configuredEmpty")}
                              />
                              <Fact
                                label={t("debug.observedLabel")}
                                value={currentVerificationStep.observedEncodedKey ?? t("debug.observedWaiting")}
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
                                  {t("debug.suggestion", { result: labelForVerificationResult(suggestedSessionResult) })}
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
                              <span className="field__label">{t("debug.stepNotes")}</span>
                              <textarea
                                rows={2}
                                value={currentVerificationStep.notes}
                                placeholder={t("debug.stepNotesPlaceholder")}
                                onChange={(event) => {
                                  handleVerificationNotesChange(event.target.value);
                                }}
                              />
                            </label>

                            {/* Primary action */}
                            <button
                              type="button"
                              className="action-button verification-action--primary"
                              onClick={() => {
                                handleVerificationResult("matched");
                              }}
                              disabled={!currentVerificationStep.observedEncodedKey}
                            >
                              {`✓ ${t("debug.matched")}`}
                            </button>

                            {/* Secondary actions row */}
                            <div className="verification-actions-secondary">
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("mismatched");
                                }}
                                disabled={!currentVerificationStep.observedEncodedKey}
                              >
                                {t("debug.mismatched")}
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("noSignal");
                                }}
                              >
                                {t("debug.noSignal")}
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  handleVerificationResult("skipped");
                                }}
                              >
                                {t("debug.skip")}
                              </button>
                              <button
                                type="button"
                                className="action-button action-button--ghost action-button--small"
                                onClick={() => {
                                  handleRestartVerificationStep();
                                }}
                                disabled={runtimeSummary.status !== "running"}
                              >
                                {t("debug.restart")}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}

                    {/* Session complete: summary table */}
                    {verificationSession.activeStepIndex >= verificationSession.steps.length ? (
                      <div className="editor-grid">
                        <Notice variant="ok">
                          <strong>{t("debug.sessionComplete")}</strong>
                          <p>
                            {t("debug.summaryMatched", { count: sessionSummary.matched })}
                            {" · "}{t("debug.summaryMismatched", { count: sessionSummary.mismatched })}
                            {" · "}{t("debug.summaryNoSignal", { count: sessionSummary.noSignal })}
                            {" · "}{t("debug.summarySkipped", { count: sessionSummary.skipped })}
                          </p>
                        </Notice>

                        <table className="verification-summary-table">
                          <thead>
                            <tr>
                              <th>{t("debug.tableButton")}</th>
                              <th>{t("debug.tableExpected")}</th>
                              <th>{t("debug.tableObserved")}</th>
                              <th>{t("debug.tableResult")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {verificationSession.steps.map((step, index) => (
                              <tr
                                key={step.controlId}
                                className="verification-summary-table__row"
                                onClick={() => {
                                  handleNavigateVerificationStep(index);
                                }}
                              >
                                <td>{step.controlLabel}</td>
                                <td><code>{step.expectedEncodedKey ?? "—"}</code></td>
                                <td><code>{step.observedEncodedKey ?? "—"}</code></td>
                                <td>
                                  <span
                                    className="verification-result-badge"
                                    ref={(el) => {
                                      if (el)
                                        el.style.setProperty(
                                          "color",
                                          verificationResultColor(step.result),
                                        );
                                    }}
                                  >
                                    {labelForVerificationResult(step.result)}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}

                    {lastVerificationExportPath ? (
                      <Notice variant="ok">
                        <strong>{t("debug.reportSaved")}</strong>
                        <p className="panel__path">{lastVerificationExportPath}</p>
                      </Notice>
                    ) : null}

                    <div className="editor-actions">
                      <button
                        type="button"
                        className="action-button action-button--secondary"
                        onClick={() => {
                          void handleExportVerificationSession();
                        }}
                        disabled={!hasVerificationResults}
                      >
                        {t("debug.exportJson")}
                      </button>
                      <button
                        type="button"
                        className="action-button action-button--ghost"
                        onClick={() => {
                          handleResetVerificationSession();
                        }}
                      >
                        {t("debug.resetSession")}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="panel__muted">
              {t("debug.selectButtonFirst")}
            </p>
          )}
        </div>
      </details>

      {/* ── Collapsible event log ── */}
      <details className="expert-log" open>
        <summary className="expert-log__summary">
          {t("debug.logTitle")}
          {logPanel.logs.length > 0 ? (
            <span className="expert-log__count">
              {" "}({logPanel.filteredLogs.length})
            </span>
          ) : null}
        </summary>
        <p className="panel__muted section-help">
          {t("debug.logHelp")}
        </p>
        <LogPanel logPanel={logPanel} />
      </details>
    </div>
  );
}
