import { useTranslation } from "react-i18next";
import type { Binding, ControlId, Layer, PhysicalControl, TriggerMode } from "../../lib/config";
import { Notice, SelectField } from "../shared";

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
      <SelectField
        className="mt-12"
        label={t("picker.triggerMode")}
        value={triggerMode}
        onChange={onChange}
        options={[
          { value: "press", label: t("picker.triggerPress") },
          { value: "doublePress", label: t("picker.triggerDoublePress") },
          { value: "triplePress", label: t("picker.triggerTriplePress") },
          { value: "hold", label: t("picker.triggerHold") },
          { value: "chord", label: t("picker.triggerChord") },
        ]}
      />

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
          <SelectField<string>
            label={t("picker.chordPartner")}
            value={chordPartner}
            onChange={(v) => setChordPartner(v as ControlId)}
            options={[
              { value: "", label: t("picker.chordPartnerEmpty") },
              ...physicalControls
                .filter((c) => c.id !== controlId && c.remappable)
                .map((c) => ({ value: c.id, label: c.defaultName })),
            ]}
          />
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
                <Notice variant="warning" className="chord-warning">
                  {t("picker.chordWarnNoPartnerBinding")}
                </Notice>
              );
            })()
          ) : null}
        </div>
      ) : null}
    </>
  );
}
