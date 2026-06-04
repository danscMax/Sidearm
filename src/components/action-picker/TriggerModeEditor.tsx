import { useTranslation } from "react-i18next";
import type { Binding, ControlId, Layer, PhysicalControl, TriggerMode } from "../../lib/config";

export function TriggerModeEditor({
  triggerMode,
  onChange,
  chordPartner,
  setChordPartner,
  controlId,
  selectedLayer,
  physicalControls,
  bindings,
}: {
  triggerMode: TriggerMode;
  onChange: (mode: TriggerMode) => void;
  chordPartner: string;
  setChordPartner: (id: string) => void;
  controlId?: ControlId;
  selectedLayer?: Layer;
  physicalControls: PhysicalControl[];
  bindings: Binding[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className="field mt-12">
        <span className="field__label">{t("picker.triggerMode")}</span>
        <select
          value={triggerMode}
          onChange={(e) => onChange(e.target.value as TriggerMode)}
        >
          <option value="press">{t("picker.triggerPress")}</option>
          <option value="doublePress">{t("picker.triggerDoublePress")}</option>
          <option value="triplePress">{t("picker.triggerTriplePress")}</option>
          <option value="hold">{t("picker.triggerHold")}</option>
          <option value="chord">{t("picker.triggerChord")}</option>
        </select>
      </label>

      {triggerMode === "chord" && controlId ? (
        <div className="field">
          <p className="panel__muted chord-explainer">
            {t("picker.chordExplainer")}
          </p>
          <div className="chord-preview">
            <span className="chord-preview__key">
              {physicalControls.find((c) => c.id === controlId)?.defaultName ?? controlId}
            </span>
            <span className="chord-preview__plus">+</span>
            <span className="chord-preview__key chord-preview__key--partner">
              {physicalControls.find((c) => c.id === chordPartner)?.defaultName ?? "…"}
            </span>
          </div>
          <label className="field">
            <span className="field__label">{t("picker.chordPartner")}</span>
            <select
              value={chordPartner}
              onChange={(e) => setChordPartner(e.target.value as ControlId)}
            >
              <option value="">{t("picker.chordPartnerEmpty")}</option>
              {physicalControls
                .filter((c) => c.id !== controlId && c.remappable)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.defaultName}
                  </option>
                ))}
            </select>
          </label>
          {chordPartner && selectedLayer ? (
            (() => {
              const partnerHasChord = bindings.some(
                (b) =>
                  b.controlId === chordPartner &&
                  b.layer === selectedLayer &&
                  b.triggerMode === "chord" &&
                  b.enabled,
              );
              return partnerHasChord ? null : (
                <p className="notice notice--warning chord-warning">
                  {t("picker.chordWarnNoPartnerBinding")}
                </p>
              );
            })()
          ) : null}
        </div>
      ) : null}
    </>
  );
}
