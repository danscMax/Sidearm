import { startTransition } from "react";
import type {
  Action,
  AppConfig,
  Binding,
  CapabilityStatus,
  ControlId,
  EncoderMapping,
  Layer,
  PhysicalControl,
  SnippetLibraryItem,
} from "../lib/config";
import type { ViewState } from "../lib/constants";
import { verificationScopeCopy } from "../lib/constants";
import type {
  EncodedKeyEvent,
  ResolvedInputPreview,
  RuntimeStateSummary,
} from "../lib/runtime";
import type {
  VerificationSession,
  VerificationSessionScope,
  VerificationSessionStep,
  VerificationSessionSummary,
  VerificationStepResult,
} from "../lib/verification-session";
import {
  expectedEncodedKeyForControl,
  seedExpectedEncoderMapping,
  updateControlCapabilityStatus,
  upsertEncoderMapping,
} from "../lib/config-editing";
import {
  controlPhysicalHint,
  describeActionSummary,
  describeVerificationAlignment,
  describeVerificationSessionSuggestion,
  dotLabel,
  formatTimestamp,
  labelForCapability,
  labelForRuntimeStatus,
  labelForVerificationResult,
  verificationResultColor,
} from "../lib/helpers";
import { MouseVisualization } from "./MouseVisualization";
import { Fact } from "./shared";
import type { FamilySection } from "./AssignmentsWorkspace";

export interface VerificationWorkspaceProps {

  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  multiSelectedControlIds: Set<ControlId>;
  familySections: FamilySection[];
  snippetById: Map<string, SnippetLibraryItem>;

  onSelectLayer: (layer: Layer) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;

  // Verification state
  verificationSession: VerificationSession | null;
  verificationScope: VerificationSessionScope;
  setVerificationScope: (scope: VerificationSessionScope) => void;
  lastVerificationExportPath: string | null;
  sessionSummary: VerificationSessionSummary;
  currentVerificationStep: VerificationSessionStep | null;
  suggestedSessionResult: Exclude<VerificationStepResult, "pending"> | null;
  hasVerificationResults: boolean;

  // Verification handlers
  handleStartVerificationSession: () => Promise<void>;
  handleRestartVerificationStep: () => void;
  handleVerificationResult: (result: Exclude<VerificationStepResult, "pending">) => void;
  handleVerificationNotesChange: (notes: string) => void;
  handleNavigateVerificationStep: (index: number) => void;
  handleReopenVerificationStep: (index: number) => void;
  handleResetVerificationSession: () => void;
  handleExportVerificationSession: () => Promise<void>;

  // Runtime state
  runtimeSummary: RuntimeStateSummary;
  viewState: ViewState;

  // Runtime handlers
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;

  // Pre-session verification card data
  lastEncodedKey: EncodedKeyEvent | null;
  lastResolutionPreview: ResolvedInputPreview | null;

  // Draft update
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
}

export function VerificationWorkspace({
  selectedLayer,
  selectedControl,
  selectedBinding,
  selectedAction,
  selectedEncoder,
  multiSelectedControlIds,
  familySections,
  snippetById,
  onSelectLayer,
  setSelectedControlId,
  setMultiSelectedControlIds,
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
  runtimeSummary,
  viewState,
  handleStartRuntime,
  handleReloadRuntime,
  handleStopRuntime,
  lastEncodedKey,
  lastResolutionPreview,
  updateDraft,
}: VerificationWorkspaceProps) {
  // --- Derived values (moved from App.tsx) ---
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

  return (
    <>
      <div className="workspace__left">
        <section className="panel">
          <MouseVisualization
            entries={familySections.flatMap((section) => section.entries)}
            selectedLayer={selectedLayer}
            multiSelectedControlIds={multiSelectedControlIds}
            onSelectControl={(id) => {
              startTransition(() => {
                setSelectedControlId(id);
                setMultiSelectedControlIds(new Set());
              });
            }}
            onToggleMultiSelect={(id) => {
              setMultiSelectedControlIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onOpenActionPicker={(id, _binding) => {
              startTransition(() => {
                setSelectedControlId(id);
                setMultiSelectedControlIds(new Set());
              });
            }}
            onSelectLayer={onSelectLayer}
          />
        </section>
      </div>

      <div className="workspace__right">
        {/* Control properties panel (verification variant) */}
        <section className="panel panel--accent">
          <p className="panel__eyebrow">Проверяемая кнопка</p>
          {selectedControl ? (
            <>
              <h2>{selectedControl.defaultName}</h2>

              <div className="fact-grid">
                <Fact
                  label="Статус"
                  value={labelForCapability(selectedControl.capabilityStatus)}
                />
                <Fact
                  label="Сигнал"
                  value={selectedEncoder?.encodedKey ?? "не назначен"}
                />
              </div>

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

              <div className="inspector__binding-card">
                <h3>Что сработает</h3>
                {selectedBinding ? (
                  <>
                    <p>
                      <strong>{selectedBinding.label}</strong>
                    </p>
                    <p>{describeActionSummary(selectedAction, snippetById)}</p>
                  </>
                ) : (
                  <p>Для этой кнопки на текущем слое назначение ещё не создано.</p>
                )}
              </div>
            </>
          ) : (
            <p>Выберите кнопку на схеме мыши</p>
          )}
        </section>

        {/* Verification panel */}
        <section className="panel">
          <p className="panel__eyebrow">Проверка кнопки</p>
          {selectedControl ? (
            <div className="editor-grid">
              <div className="compound-card">
                {/* Session header: scope selector + start/reset */}
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

                {/* Step progress bar */}
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

                            {/* Primary action: Совпало */}
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

        {/* Runtime panel */}
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

        </section>
      </div>
    </>
  );
}
