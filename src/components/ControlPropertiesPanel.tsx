import { useTranslation } from "react-i18next";
import type {
  Action,
  AppConfig,
  Binding,
  CapabilityStatus,
  EncoderMapping,
  Layer,
  PhysicalControl,
  SnippetLibraryItem,
} from "../lib/config";
import type {
  EncodedKeyEvent,
  ResolvedInputPreview,
} from "../lib/runtime";
import {
  expectedEncodedKeyForControl,
  seedExpectedEncoderMapping,
  updateControlCapabilityStatus,
  upsertEncoderMapping,
} from "../lib/config-editing";
import {
  formatTimestamp,
  labelForCapability,
  labelForControlFamily,
} from "../lib/labels";
import { describeActionSummary } from "../lib/action-helpers";
import { describeVerificationAlignment } from "../lib/verification-helpers";

export interface ControlPropertiesPanelProps {
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  snippetById: Map<string, SnippetLibraryItem>;
  // Verification-mode props (optional — omit for read-only display)
  selectedLayer?: Layer;
  lastEncodedKey?: EncodedKeyEvent | null;
  lastResolutionPreview?: ResolvedInputPreview | null;
  updateDraft?: (updater: (config: AppConfig) => AppConfig) => void;
  verificationSessionActive?: boolean;
}

export function ControlPropertiesPanel({
  selectedControl,
  selectedBinding,
  selectedAction,
  selectedEncoder,
  snippetById,
  selectedLayer,
  lastEncodedKey,
  lastResolutionPreview,
  updateDraft,
  verificationSessionActive,
}: ControlPropertiesPanelProps) {
  const { t } = useTranslation();
  const hasVerificationMode = selectedLayer != null && updateDraft != null;

  // Verification-mode derived values
  const expectedEncodedKey =
    hasVerificationMode && selectedControl
      ? expectedEncodedKeyForControl(selectedControl.id, selectedLayer)
      : null;
  const lastObservedEncodedKey = lastEncodedKey?.encodedKey ?? null;
  const lastObservedResolvedSelectedControl = Boolean(
    selectedControl &&
      lastResolutionPreview?.controlId === selectedControl.id &&
      lastResolutionPreview?.layer === selectedLayer &&
      lastEncodedKey,
  );
  const verificationAlignment =
    hasVerificationMode && selectedControl
      ? describeVerificationAlignment(
          expectedEncodedKey,
          selectedEncoder?.encodedKey ?? null,
          lastObservedEncodedKey,
          lastObservedResolvedSelectedControl,
        )
      : null;

  if (!selectedControl) {
    return (
      <section className="panel panel--accent">
        <div className="props-empty">
          <p className="props-empty__icon">⊹</p>
          <p className="props-empty__text">{t("properties.empty")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel--accent">
      {/* ── Identity & metadata ── */}
      <div className="props-header">
        <div className="props-header__title">
          <h2>{selectedControl.defaultName}</h2>
          {selectedEncoder?.encodedKey ? (
            <code className="props-header__signal">{selectedEncoder.encodedKey}</code>
          ) : (
            <span className="props-header__signal props-header__signal--empty">{t("properties.signalEmpty")}</span>
          )}
        </div>
        <span className="props-header__group">{labelForControlFamily(selectedControl.family)}</span>
      </div>

      {hasVerificationMode ? (
        <div className="props-meta">
          <div className="props-meta__status">
            <span className="props-meta__label">{t("properties.status")}</span>
            <span className="props-meta__value">{labelForCapability(selectedControl.capabilityStatus)}</span>
          </div>
          <label className="props-meta__select">
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
              <option value="verified">{t("inspector.capabilityVerified")}</option>
              <option value="needsValidation">{t("inspector.capabilityNeedsValidation")}</option>
              <option value="partiallyRemappable">{t("inspector.capabilityPartially")}</option>
              <option value="reserved">{t("inspector.capabilityReserved")}</option>
            </select>
          </label>
        </div>
      ) : null}

      {/* ── Action preview ── */}
      <div className="props-action">
        <span className="props-action__eyebrow">{t("properties.actionEyebrow")}</span>
        {selectedBinding ? (
          <div className="props-action__body">
            <strong className="props-action__name">{selectedBinding.label}</strong>
            <span className="props-action__detail">{describeActionSummary(selectedAction, snippetById)}</span>
          </div>
        ) : (
          <p className="props-action__empty">{t("properties.actionEmpty")}</p>
        )}
      </div>

      {/* ── Verification workflow ── */}
      {hasVerificationMode && !verificationSessionActive && verificationAlignment ? (
        <div className="props-verification">
          <div className={`notice ${verificationAlignment.noticeClass}`}>
            <strong>{verificationAlignment.title}</strong>
            <p>{verificationAlignment.body}</p>
            <p className="notice__meta">
              {lastObservedResolvedSelectedControl
                ? t("debug.verificationMatch")
                : t("debug.verificationOther")}
            </p>
          </div>

          <div className="props-signals">
            <div className="props-signal">
              <span className="props-signal__label">{t("properties.expected")}</span>
              <code className="props-signal__value">{expectedEncodedKey ?? t("common.na")}</code>
            </div>
            <div className="props-signal">
              <span className="props-signal__label">{t("properties.configured")}</span>
              <code className="props-signal__value">{selectedEncoder?.encodedKey ?? "—"}</code>
            </div>
            <div className="props-signal">
              <span className="props-signal__label">{t("properties.observed")}</span>
              <code className="props-signal__value props-signal__value--observed">
                {lastObservedEncodedKey ?? t("properties.observedEmpty")}
              </code>
            </div>
            <div className="props-signal">
              <span className="props-signal__label">{t("properties.time")}</span>
              <span className="props-signal__value">
                {lastEncodedKey ? formatTimestamp(lastEncodedKey.receivedAt) : t("common.na")}
              </span>
            </div>
          </div>

          <div className="verification-steps">
            <button
              type="button"
              className={`verification-step${expectedEncodedKey ? " verification-step--ready" : ""}`}
              onClick={() => {
                updateDraft((config) =>
                  seedExpectedEncoderMapping(config, selectedLayer, selectedControl),
                );
              }}
              disabled={!expectedEncodedKey}
            >
              <span className="verification-step__num">1</span>
              <span className="verification-step__label">
                {selectedEncoder ? t("properties.applyExpected") : t("properties.createExpected")}
              </span>
            </button>

            <button
              type="button"
              className={`verification-step${lastObservedEncodedKey && selectedEncoder ? " verification-step--ready" : ""}`}
              onClick={() => {
                if (!lastObservedEncodedKey) return;
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
              <span className="verification-step__num">2</span>
              <span className="verification-step__label">{t("properties.observedSignal")}</span>
            </button>

            <button
              type="button"
              className={`verification-step${
                selectedEncoder &&
                lastObservedEncodedKey &&
                selectedEncoder.encodedKey === lastObservedEncodedKey
                  ? " verification-step--ready"
                  : ""
              }`}
              onClick={() => {
                if (!selectedEncoder) return;
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
              <span className="verification-step__num">3</span>
              <span className="verification-step__label">{t("properties.confirm")}</span>
            </button>

            <button
              type="button"
              className={`verification-step${selectedEncoder?.verified ? " verification-step--ready" : ""}`}
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
              <span className="verification-step__num">4</span>
              <span className="verification-step__label">{t("properties.promoteStatus")}</span>
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
