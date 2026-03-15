import type { RuntimeStateSummary } from "../lib/runtime";
import type { ViewState } from "../lib/constants";
import { formatTimestamp, labelForRuntimeStatus } from "../lib/labels";
import { Fact } from "./shared";

export interface RuntimePanelProps {
  runtimeSummary: RuntimeStateSummary;
  viewState: ViewState;
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;
  handleRehookCapture: () => Promise<void>;
}

export function RuntimePanel({
  runtimeSummary,
  viewState,
  handleStartRuntime,
  handleReloadRuntime,
  handleStopRuntime,
  handleRehookCapture,
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
        <button
          type="button"
          className="action-button action-button--secondary"
          onClick={() => {
            void handleRehookCapture();
          }}
          disabled={
            viewState === "loading" ||
            viewState === "saving" ||
            runtimeSummary.status !== "running"
          }
          title="Переустановить WH_KEYBOARD_LL хук без перезапуска рантайма"
        >
          Переустановить хук
        </button>
      </div>

      <div className="fact-grid">
        <Fact label="Состояние" value={labelForRuntimeStatus(runtimeSummary.status)} />
        <Fact label="Бэкенд" value={runtimeSummary.captureBackend} mono />
        <Fact
          label="Версия конфигурации"
          value={String(runtimeSummary.activeConfigVersion ?? "н/д")}
          mono
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
  );
}
