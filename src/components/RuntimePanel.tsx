import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <section className="panel">
      <p className="panel__eyebrow">{t("runtime.panelTitle")}</p>
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
          {t("runtime.start")}
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
          {t("runtime.reload")}
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
          {t("runtime.stop")}
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
          title={t("runtime.rehookTooltip")}
        >
          {t("runtime.rehook")}
        </button>
      </div>

      <div className="fact-grid">
        <Fact label={t("runtime.status")} value={labelForRuntimeStatus(runtimeSummary.status)} />
        <Fact label={t("runtime.backend")} value={runtimeSummary.captureBackend} mono />
        <Fact
          label={t("runtime.configVersion")}
          value={String(runtimeSummary.activeConfigVersion ?? t("common.na"))}
          mono
        />
        <Fact
          label={t("runtime.warnings")}
          value={String(runtimeSummary.warningCount)}
        />
        <Fact
          label={t("runtime.started")}
          value={formatTimestamp(runtimeSummary.startedAt)}
        />
        <Fact
          label={t("runtime.lastReload")}
          value={formatTimestamp(runtimeSummary.lastReloadAt)}
        />
      </div>
    </section>
  );
}
