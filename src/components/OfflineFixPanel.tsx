import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, OfflineLayer } from "../lib/config";
import type { OfflinePreview } from "../lib/onboard-mapping";
import {
  applyAllOfflineSuggestions,
  applyOfflineSuggestion,
  buildOfflineFixPlan,
  type OfflineFixItem,
  type OfflinePayload,
} from "../lib/offline-suggestions";
import { PillTrack } from "./PillTrack";

export interface OfflineFixPanelProps {
  config: AppConfig;
  profileId: string;
  deviceId: string;
  preview: OfflinePreview | null;
  hybridBankActive?: boolean;
  onApplyConfig: (updater: (config: AppConfig) => AppConfig) => void;
  onEditControl: (controlId: ControlId, layer: OfflineLayer) => void;
  onToast: (message: string, variant?: "info" | "success" | "warning") => void;
}

type LayerFilter = "all" | "offline" | "offlineHypershift";

export function OfflineFixPanel({
  config,
  profileId,
  deviceId,
  preview,
  hybridBankActive = false,
  onApplyConfig,
  onEditControl,
  onToast,
}: OfflineFixPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<LayerFilter>("all");
  const toggleRef = useRef<HTMLButtonElement>(null);

  const plan = useMemo(
    () => buildOfflineFixPlan(config, profileId, deviceId, preview, t),
    [config, profileId, deviceId, preview, t],
  );

  if (!preview) return null;

  if (hybridBankActive) {
    return (
      <div className="offline-fix offline-fix--clean" role="status">
        <span className="offline-fix__summary">{t("offlineFix.hybridBankNotice")}</span>
      </div>
    );
  }

  const standardCount = plan.items.filter((item) => item.layer === "offline").length;
  const hsCount = plan.items.filter((item) => item.layer === "offlineHypershift").length;
  // Fall back to "all" when the selected layer filter becomes empty so remaining rows stay visible.
  const effectiveFilter: LayerFilter =
    (filter === "offline" && standardCount === 0) || (filter === "offlineHypershift" && hsCount === 0)
      ? "all"
      : filter;
  const visibleItems = effectiveFilter === "all"
    ? plan.items
    : plan.items.filter((item) => item.layer === effectiveFilter);
  const autoFixable = visibleItems.filter((item) => item.suggestions.some((s) => s.autoApply));

  function applyOne(item: OfflineFixItem, payload: OfflinePayload, label: string) {
    onApplyConfig((current) => applyOfflineSuggestion(current, profileId, item.controlId, item.layer, payload));
    onToast(t("offlineFix.appliedOne", { button: item.controlLabel, label }), "success");
    queueMicrotask(() => toggleRef.current?.focus());
  }

  function applyAll() {
    if (autoFixable.length === 0) return;
    let applied = 0;
    onApplyConfig((current) => {
      const result = applyAllOfflineSuggestions(current, profileId, autoFixable);
      applied = result.applied;
      return result.config;
    });
    if (applied > 0) {
      onToast(t("offlineFix.appliedAll", { count: applied }), "success");
    }
  }

  if (plan.items.length === 0) {
    const verifiedPlayable =
      preview.target.state !== "notWritten" &&
      preview.target.state !== "unknown" &&
      !preview.controls.some((control) => control.kind === "unavailable");
    return (
      <div className="offline-fix offline-fix--clean" role="status">
        <span className="offline-fix__summary">
          {t(verifiedPlayable ? "offlineFix.allReady" : "offlineFix.noneToFix")}
        </span>
        {plan.ownCount > 0 ? (
          <span className="offline-fix__meta">{t("offlineFix.ownCount", { count: plan.ownCount })}</span>
        ) : null}
      </div>
    );
  }

  return (
    <section className="offline-fix" aria-label={t("offlineFix.title")}>
      <div className="offline-fix__bar">
        <div className="offline-fix__head">
          <strong className="offline-fix__title">{t("offlineFix.needsFix", { count: plan.items.length })}</strong>
          <span className="offline-fix__meta">
            {t("offlineFix.layerCounts", { standard: standardCount, hypershift: hsCount })}
            {plan.ownCount > 0 ? ` · ${t("offlineFix.ownCount", { count: plan.ownCount })}` : ""}
          </span>
        </div>
        <div className="offline-fix__bar-actions">
          {autoFixable.length > 0 ? (
            <button
              type="button"
              className="action-button action-button--small"
              onClick={applyAll}
            >
              {t("offlineFix.applyAll", { count: autoFixable.length })}
            </button>
          ) : null}
          <button
            ref={toggleRef}
            type="button"
            className="action-button action-button--secondary action-button--small"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? t("offlineFix.collapse") : t("offlineFix.expand")}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="offline-fix__body">
          <div className="offline-fix__toolbar">
            <p className="panel__muted help-sm">{t("offlineFix.lead")}</p>
            {standardCount > 0 && hsCount > 0 ? (
              <PillTrack
                items={[
                  { key: "all", label: t("offlineFix.filterAll", { count: plan.items.length }) },
                  { key: "offline", label: t("offlineFix.filterStandard", { count: standardCount }) },
                  { key: "offlineHypershift", label: t("offlineFix.filterHypershift", { count: hsCount }) },
                ]}
                active={effectiveFilter}
                onSelect={(key) => setFilter(key as LayerFilter)}
              />
            ) : null}
          </div>

          <ul className="offline-fix__list">
            {visibleItems.map((item) => (
              <li key={`${item.layer}:${item.controlId}`} className="offline-fix__row">
                <div className="offline-fix__where">
                  <span className="offline-fix__btn-name">{item.controlLabel}</span>
                  <span className="offline-fix__layer-tag">
                    {t(item.layer === "offlineHypershift" ? "offline.hypershift" : "offline.standard")}
                  </span>
                </div>

                <div className="offline-fix__status">
                  <span className="offline-fix__live" title={item.liveLabel}>{item.liveLabel}</span>
                  <span className="offline-fix__arrow" aria-hidden="true">→</span>
                  <span className="offline-fix__offline">{item.currentOfflineLabel}</span>
                </div>

                <div className="offline-fix__choices">
                  {item.suggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      className={`offline-fix__chip${index === 0 ? " offline-fix__chip--primary" : ""}`}
                      title={suggestion.hint ? `${suggestion.source} · ${suggestion.hint}` : suggestion.source}
                      onClick={() => applyOne(item, suggestion.payload, suggestion.label)}
                    >
                      <span className="offline-fix__chip-label">{suggestion.label}</span>
                      <span className="offline-fix__chip-src">{suggestion.source}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="offline-fix__chip offline-fix__chip--custom"
                    onClick={() => onEditControl(item.controlId, item.layer)}
                  >
                    {t("offlineFix.chooseCustom")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
