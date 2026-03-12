import type { RuntimeStateSummary } from "../lib/runtime";
import type { ViewState } from "../lib/constants";
import { formatTimestamp, labelForRuntimeStatus } from "../lib/helpers";
import { Fact } from "./shared";

export interface RuntimePanelProps {
  runtimeSummary: RuntimeStateSummary;
  isDirty: boolean;
  viewState: ViewState;
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;
}

export function RuntimePanel({
  runtimeSummary,
  isDirty,
  viewState,
  handleStartRuntime,
  handleReloadRuntime,
  handleStopRuntime,
}: RuntimePanelProps) {
  return (
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
  );
}
