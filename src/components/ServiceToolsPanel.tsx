import { useOptimistic } from "react";
import { enable as enableAutostart, disable as disableAutostart } from "@tauri-apps/plugin-autostart";

import { normalizeCommandError } from "../lib/backend";
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
  setError,
}: ServiceToolsPanelProps) {
  const [optimisticAutostart, setOptimisticAutostart] = useOptimistic(
    activeConfig.settings.startWithWindows,
  );

  const resolvedLiveRunnable =
    lastResolutionPreview?.actionId
      ? isActionLiveRunnable(activeConfig, lastResolutionPreview.actionId)
      : false;
  const canRunLiveAction =
    lastResolutionPreview?.status === "resolved" &&
    resolvedLiveRunnable;

  return (
    <PanelGroup title="Служебные инструменты" defaultOpen>
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
              <Fact label="Исполняемый файл" value={lastCapture.exe} mono />
              <Fact label="HWND" value={lastCapture.hwnd} mono />
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
              {lastCapture.isElevated && (
                <p className="panel__warning">
                  Процесс запущен от имени администратора. SendInput будет
                  заблокирован UIPI — действия не дойдут до этого окна.
                </p>
              )}
            </div>
          ) : (
            <p className="panel__muted">
              Поставьте небольшую задержку, переключитесь в другое окно и
              затем захватите его, чтобы проверить выбор профиля.
            </p>
          )}
        </div>
      </section>

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
            className="action-button action-button--warning"
            onClick={() => {
              void handleRunPreviewAction();
            }}
            disabled={!canRunLiveAction}
          >
            ⚠ Выполнить вживую
          </button>

          {lastEncodedKey ? (
            <div className="fact-grid">
              <Fact label="Сигнал" value={lastEncodedKey.encodedKey} mono />
              <Fact label="Бэкенд" value={lastEncodedKey.backend} mono />
              <Fact label="Получен" value={formatTimestamp(lastEncodedKey.receivedAt)} />
            </div>
          ) : null}

          {lastResolutionPreview ? (
            <div className="fact-grid">
              <Fact label="Статус" value={labelForPreviewStatus(lastResolutionPreview.status)} />
              <Fact
                label="Профиль"
                value={
                  lastResolutionPreview.resolvedProfileId
                    ? (profiles.find((p) => p.id === lastResolutionPreview.resolvedProfileId)?.name ??
                        lastResolutionPreview.resolvedProfileId)
                    : "н/д"
                }
              />
              <Fact
                label="Кнопка"
                value={
                  lastResolutionPreview.controlId
                    ? controlName(activeConfig.physicalControls, lastResolutionPreview.controlId)
                    : "н/д"
                }
              />
              <Fact
                label="Слой"
                value={lastResolutionPreview.layer ?? "н/д"}
                mono
              />
              <Fact
                label="Назначение"
                value={lastResolutionPreview.bindingId ?? "н/д"}
                mono
              />
              <Fact
                label="Действие"
                value={lastResolutionPreview.actionId ?? "н/д"}
                mono
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

      <section className="panel">
        <p className="panel__eyebrow">Журнал событий</p>
        <LogPanel logPanel={logPanel} />
      </section>

      <section className="panel">
        <p className="panel__eyebrow">Сохранение</p>
        <p className="panel__path">{activePath}</p>
        {lastSave?.backupPath ? (
          <p className="panel__muted">
            Последняя резервная копия: <code>{lastSave.backupPath}</code>
          </p>
        ) : null}
        {error ? <ErrorPanel error={error} /> : null}
        {!error && activeWarnings.length > 0 ? (
          <WarningsPanel warnings={activeWarnings} />
        ) : null}
        {!error && activeWarnings.length === 0 ? (
          <div className="notice notice--ok">
            <strong>Предупреждений нет</strong>
            <p>
              Текущая сохранённая конфигурация прошла загрузку и
              сохранение без предупреждений.
            </p>
          </div>
        ) : null}
      </section>

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
              checked={optimisticAutostart}
              onChange={(event) => {
                const enabled = event.target.checked;
                setOptimisticAutostart(enabled);
                (enabled ? enableAutostart() : disableAutostart())
                  .then(() => {
                    updateDraft((config) => ({
                      ...config,
                      settings: {
                        ...config.settings,
                        startWithWindows: enabled,
                      },
                    }));
                  })
                  .catch((unknownError: unknown) => {
                    setError(normalizeCommandError(unknownError));
                  });
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
    </PanelGroup>
  );
}
