import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, OfflineLayer } from "../lib/config";
import type { OfflinePreview } from "../lib/onboard-mapping";
import {
  applyAllOfflineSuggestions,
  applyOfflineSuggestion,
  buildOfflineFixPlan,
  copyOfflineLayerFromFallback,
  resetAllOfflineOverrides,
  type OfflineFixItem,
  type OfflinePayload,
} from "../lib/offline-suggestions";
import { ControlPreviewPopover } from "./ControlPreviewPopover";
import { PillTrack } from "./PillTrack";

export interface OfflineFixPanelProps {
  config: AppConfig;
  profileId: string;
  deviceId: string;
  preview: OfflinePreview | null;
  hybridBankActive?: boolean;
  onApplyConfig: (updater: (config: AppConfig) => AppConfig) => void;
  onEditControl: (controlId: ControlId, layer: OfflineLayer, initialSuggestion?: OfflinePayload) => void;
  onToast: (message: string, variant?: "info" | "success" | "warning") => void;
}

type LayerFilter = "all" | "offline" | "offlineHypershift";

function PencilIcon() {
  return (
    <svg className="offline-fix__edit-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.6 2.4a1.6 1.6 0 0 1 2.26 2.26l-8.1 8.1-3.16.9.9-3.16 8.1-8.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  const [confirmReset, setConfirmReset] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setConfirmReset(false);
  }, [profileId, deviceId]);

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
  const fallbackProfile = config.settings.fallbackProfileId !== profileId
    ? config.profiles.find((p) => p.id === config.settings.fallbackProfileId) ?? null
    : null;
  const fallbackCopyCount = useMemo(
    () => (fallbackProfile ? copyOfflineLayerFromFallback(config, profileId, plan.items).copied : 0),
    [fallbackProfile, config, profileId, plan.items],
  );

  function applyOne(item: OfflineFixItem, payload: OfflinePayload, label: string) {
    setConfirmReset(false);
    onApplyConfig((current) => applyOfflineSuggestion(current, profileId, item.controlId, item.layer, payload));
    onToast(t("offlineFix.appliedOne", { button: item.controlLabel, label }), "success");
    queueMicrotask(() => toggleRef.current?.focus());
  }

  function applyAll() {
    if (autoFixable.length === 0) return;
    setConfirmReset(false);
    const previewCount = applyAllOfflineSuggestions(config, profileId, autoFixable).applied;
    onApplyConfig((current) => applyAllOfflineSuggestions(current, profileId, autoFixable).config);
    if (previewCount > 0) {
      onToast(t("offlineFix.appliedAll", { count: previewCount }), "success");
    }
  }

  function copyFromFallback() {
    if (!fallbackProfile || fallbackCopyCount === 0) return;
    setConfirmReset(false);
    const count = fallbackCopyCount;
    onApplyConfig((current) => copyOfflineLayerFromFallback(current, profileId, plan.items).config);
    onToast(t("offlineFix.copiedFromFallback", { name: fallbackProfile.name, count }), "success");
  }

  function resetOwnOverrides() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    const removed = resetAllOfflineOverrides(config, profileId, deviceId).removed;
    onApplyConfig((current) => resetAllOfflineOverrides(current, profileId, deviceId).config);
    if (removed > 0) {
      onToast(t("offlineFix.resetDone", { count: removed }), "info");
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
          <div className="offline-fix__bar-actions">
            <span className="offline-fix__meta-pill">{t("offlineFix.ownCount", { count: plan.ownCount })}</span>
            <button
              type="button"
              className={`action-button action-button--small${confirmReset ? " action-button--danger" : " action-button--secondary"}`}
              onClick={resetOwnOverrides}
              onBlur={() => setConfirmReset(false)}
            >
              {confirmReset ? t("offlineFix.resetConfirm") : t("offlineFix.resetOwn")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="offline-fix" aria-label={t("offlineFix.title")}>
      <div className="offline-fix__bar">
        <div className="offline-fix__head">
          <strong className="offline-fix__title">{t("offlineFix.needsFix", { count: plan.items.length })}</strong>
          <div className="offline-fix__meta-pills">
            {standardCount > 0 ? (
              <span className="offline-fix__meta-pill">
                {t("offlineFix.standardBadge", { count: standardCount })}
              </span>
            ) : null}
            {hsCount > 0 ? (
              <span className="offline-fix__meta-pill">
                {t("offlineFix.hypershiftBadge", { count: hsCount })}
              </span>
            ) : null}
            {plan.ownCount > 0 ? (
              <span className="offline-fix__meta-pill offline-fix__meta-pill--accent">
                {t("offlineFix.ownCount", { count: plan.ownCount })}
              </span>
            ) : null}
          </div>
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
          {fallbackProfile && fallbackCopyCount > 0 ? (
            <button
              type="button"
              className="action-button action-button--secondary action-button--small"
              onClick={copyFromFallback}
            >
              {t("offlineFix.copyFromFallback", { name: fallbackProfile.name, count: fallbackCopyCount })}
            </button>
          ) : null}
          {plan.ownCount > 0 ? (
            <button
              type="button"
              className={`action-button action-button--small${confirmReset ? " action-button--danger" : " action-button--secondary"}`}
              onClick={resetOwnOverrides}
              onBlur={() => setConfirmReset(false)}
            >
              {confirmReset ? t("offlineFix.resetConfirm") : t("offlineFix.resetOwn")}
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
                  <ControlPreviewPopover
                    controlId={item.controlId}
                    deviceId={deviceId}
                    label={item.controlLabel}
                  />
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
                      title={suggestion.hint ? `${suggestion.source}: ${suggestion.hint}` : suggestion.source}
                      onClick={() => applyOne(item, suggestion.payload, suggestion.label)}
                    >
                      <span className="offline-fix__chip-label">{suggestion.label}</span>
                      <span className="offline-fix__chip-src">{suggestion.source}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="offline-fix__chip offline-fix__chip--custom"
                    onClick={() => onEditControl(item.controlId, item.layer, item.suggestions[0]?.payload)}
                  >
                    <PencilIcon />
                    <span>{t("offlineFix.edit")}</span>
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
