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
import { controlName } from "../lib/helpers";
import {
  formatTimestamp,
  labelForExecutionMode,
  labelForExecutionOutcome,
  labelForPreviewStatus,
  labelForVerificationResult,
} from "../lib/labels";
import {
  controlPhysicalHint,
  describeVerificationSessionSuggestion,
  dotLabel,
  verificationResultColor,
} from "../lib/verification-helpers";
import { isActionLiveRunnable } from "../lib/action-helpers";

import { ControlPropertiesPanel } from "./ControlPropertiesPanel";
import { LogPanel } from "./LogPanel";
import { Fact } from "./shared";
import type { LogPanelControl } from "../hooks/useLogPanel";

export interface DebugRuntimeProps {
  debugLog: DebugLogEntry[];
  resolutionKeyInput: string;
  setResolutionKeyInput: (value: string) => void;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  lastEncodedKey: EncodedKeyEvent | null;
  runtimeSummary: RuntimeStateSummary;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
}

export interface DebugVerificationProps {
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
            placeholder="Код сигнала (F13, Ctrl+Shift+F20...)"
            title="Код сигнала, который отправляет мышь при нажатии кнопки"
            onKeyDown={(event) => {
              if (event.key === "Enter" && resolutionKeyInput.trim()) {
                void handlePreviewResolution();
              }
            }}
          />
          <div className="debug-testing__actions">
            <button
              type="button"
              className="action-button"
              onClick={() => { void handlePreviewResolution(); }}
              disabled={!resolutionKeyInput.trim()}
              title="Определить профиль и действие для введённого кода сигнала"
            >
              Проверить
            </button>
            <button
              type="button"
              className="action-button action-button--secondary"
              onClick={() => { void handleExecutePreviewAction(); }}
              disabled={!resolutionKeyInput.trim()}
              title="Имитировать выполнение действия (без реальных нажатий клавиш)"
            >
              Пробный
            </button>
            <button
              type="button"
              className="action-button action-button--warning"
              onClick={() => { void handleRunPreviewAction(); }}
              disabled={!canRunLiveAction}
              title="Выполнить привязанное действие по-настоящему (отправит клавиши в систему)"
            >
              Вживую
            </button>
          </div>
        </div>
        <p className="panel__muted" style={{ fontSize: "0.75rem", margin: "6px 0 0" }}>
          Введите код сигнала (например F13, Ctrl+Shift+F20) и нажмите Проверить, чтобы узнать, какой профиль и действие будут выполнены.
          Пробный выполнит действие без реальных нажатий. Вживую выполнит действие по-настоящему.
        </p>

        {lastResolutionPreview ? (
          <div className="fact-grid" style={{ marginTop: 10 }}>
            <Fact
              label="Профиль"
              value={lastResolutionPreview.resolvedProfileId
                ? (profiles.find((p) => p.id === lastResolutionPreview.resolvedProfileId)?.name ??
                    lastResolutionPreview.resolvedProfileId)
                : "н/д"}
            />
            <Fact
              label="Кнопка"
              value={lastResolutionPreview.controlId
                ? controlName(activeConfig.physicalControls, lastResolutionPreview.controlId)
                : "н/д"}
            />
            <Fact label="Результат" value={labelForPreviewStatus(lastResolutionPreview.status)} />
            {lastResolutionPreview.actionId ? (
              <Fact label="Действие" value={lastResolutionPreview.actionId} mono />
            ) : null}
          </div>
        ) : null}

        {lastExecution ? (
          <div className="fact-grid" style={{ marginTop: 8 }}>
            <Fact label="Исход" value={labelForExecutionOutcome(lastExecution.outcome)} />
            <Fact label="Режим" value={labelForExecutionMode(lastExecution.mode)} />
            <Fact label="Действие" value={lastExecution.actionId} mono />
            <Fact label="Время" value={formatTimestamp(lastExecution.executedAt)} />
          </div>
        ) : null}

        {lastRuntimeError ? (
          <div className="notice notice--error" style={{ margin: "10px 0 0" }} title="Последняя ошибка рантайма">
            <strong>{lastRuntimeError.category}</strong>
            <p>{lastRuntimeError.message}</p>
          </div>
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
          updateDraft={updateDraft}
          verificationSessionActive={!!verificationSession}
        />
      </div>

      {/* ── Collapsible verification session ── */}
      <details className="expert-log">
        <summary className="expert-log__summary">
          Сессия проверки
          {verificationSession ? (
            <span className="expert-log__count">
              {" "}({sessionSummary.matched + sessionSummary.mismatched + sessionSummary.noSignal + sessionSummary.skipped}
              /{verificationSession.steps.length})
            </span>
          ) : null}
        </summary>
        <p className="panel__muted" style={{ fontSize: "0.75rem", padding: "0 20px 8px" }}>
          Пошаговая проверка каждой кнопки мыши. Нажимайте кнопки на устройстве и отмечайте, совпадает ли результат с ожидаемым.
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
                        <strong>Сессия проверки</strong>
                        <span className="compound-card__meta">
                          Пошаговая проверка каждой кнопки на реальном устройстве.
                        </span>
                      </div>
                      <label className="field verification-session__scope">
                        <span className="field__label">Объём</span>
                        <select
                          value={verificationScope}
                          onChange={(event) => {
                            setVerificationScope(
                              event.target.value as VerificationSessionScope,
                            );
                          }}
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
                        verificationScopeCopy.find(
                          (scope) => scope.value === verificationScope,
                        )?.body
                      }
                    </p>

                    <div className="editor-actions">
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => {
                          void handleStartVerificationSession();
                        }}
                      >
                        {runtimeSummary.status !== "running"
                          ? "Запустить перехват и начать"
                          : "Начать сессию"}
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
                          Шаг {Math.min(verificationSession.activeStepIndex + 1, verificationSession.steps.length)}
                          {" / "}
                          {verificationSession.steps.length}
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
                            style={{
                              backgroundColor:
                                index === verificationSession.activeStepIndex
                                  ? undefined
                                  : verificationResultColor(step.result),
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
                            Нажмите: {currentVerificationStep.controlLabel}
                          </h3>
                          <p className="verification-instruction__hint">
                            {controlPhysicalHint[currentVerificationStep.controlId] ??
                              "Расположение этой кнопки пока не описано."}
                          </p>
                        </div>

                        {currentVerificationStep.result !== "pending" ? (
                          <div className="notice notice--info">
                            <strong>
                              Этот шаг уже завершён: {labelForVerificationResult(currentVerificationStep.result)}
                            </strong>
                            <p>
                              Вы можете перепроверить его или перейти к другому шагу.
                            </p>
                            <div className="editor-actions mt-8">
                              <button
                                type="button"
                                className="action-button action-button--small"
                                onClick={() => {
                                  handleReopenVerificationStep(verificationSession.activeStepIndex);
                                }}
                              >
                                Перепроверить
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
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
                                value={currentVerificationStep.observedEncodedKey ?? "ожидание сигнала…"}
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
                                rows={2}
                                value={currentVerificationStep.notes}
                                placeholder="Например: сработало только после повторного нажатия."
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
                              ✓ Совпало
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
                              <button
                                type="button"
                                className="action-button action-button--ghost action-button--small"
                                onClick={() => {
                                  handleRestartVerificationStep();
                                }}
                                disabled={runtimeSummary.status !== "running"}
                              >
                                Перезапустить
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}

                    {/* Session complete: summary table */}
                    {verificationSession.activeStepIndex >= verificationSession.steps.length ? (
                      <div className="editor-grid">
                        <div className="notice notice--ok">
                          <strong>Сессия завершена</strong>
                          <p>
                            Совпало: {sessionSummary.matched} · Не совпало: {sessionSummary.mismatched}
                            {" · "}Нет сигнала: {sessionSummary.noSignal} · Пропущено: {sessionSummary.skipped}
                          </p>
                        </div>

                        <table className="verification-summary-table">
                          <thead>
                            <tr>
                              <th>Кнопка</th>
                              <th>Ожидалось</th>
                              <th>Наблюдалось</th>
                              <th>Результат</th>
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
                                    style={{ color: verificationResultColor(step.result) }}
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
                      <div className="notice notice--ok">
                        <strong>Отчёт сохранён</strong>
                        <p className="panel__path">{lastVerificationExportPath}</p>
                      </div>
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
                        Экспорт JSON
                      </button>
                      <button
                        type="button"
                        className="action-button action-button--ghost"
                        onClick={() => {
                          handleResetVerificationSession();
                        }}
                      >
                        Сбросить сессию
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="panel__muted">
              Выберите кнопку перед началом сессии проверки.
            </p>
          )}
        </div>
      </details>

      {/* ── Collapsible event log ── */}
      <details className="expert-log" open>
        <summary className="expert-log__summary">
          Журнал событий
          {logPanel.logs.length > 0 ? (
            <span className="expert-log__count">
              {" "}({logPanel.filteredLogs.length})
            </span>
          ) : null}
        </summary>
        <p className="panel__muted" style={{ fontSize: "0.75rem", padding: "0 20px 8px" }}>
          Все события перехвата, ошибки и действия в реальном времени. Фильтруйте по уровню, категории или тексту.
        </p>
        <LogPanel logPanel={logPanel} />
      </details>
    </div>
  );
}
