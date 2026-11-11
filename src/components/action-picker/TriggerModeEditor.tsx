import { useTranslation } from "react-i18next";
import type { Binding, ControlId, Layer, PhysicalControl, TriggerMode } from "../../lib/config";
import { displayNameForControl } from "../../lib/labels";
import { HelpTip, Notice, SelectField } from "../shared";

export function TriggerModeEditor({
  triggerMode,
  onChange,
  chordPartner,
  setChordPartner,
  controlId,
  selectedLayer,
  physicalControls,
  bindings,
  sideButtonsOneAtATime = false,
}: {
  triggerMode: TriggerMode;
  onChange: (mode: TriggerMode) => void;
  chordPartner: string;
  setChordPartner: (id: string) => void;
  controlId?: ControlId;
  selectedLayer?: Layer;
  physicalControls: PhysicalControl[];
  bindings: Binding[];
  /** A built-in Naga key button: the mouse reports one of them at a time. */
  sideButtonsOneAtATime?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SelectField
        label={
          <>
            {t("picker.triggerMode")}
            <HelpTip text={t("picker.triggerModeHelp")} />
          </>
        }
        value={triggerMode}
        onChange={onChange}
        options={[
          { value: "press", label: t("picker.triggerPress") },
          { value: "hold", label: t("picker.triggerHold") },
          { value: "chord", label: t("picker.triggerChord") },
        ]}
      />
      {sideButtonsOneAtATime && (triggerMode === "hold" || triggerMode === "chord") ? (
        <p className="panel__muted help-sm">{t("picker.sideButtonsOneAtATime")}</p>
      ) : null}

      {triggerMode === "chord" && controlId ? (
        <div className="field">
          <p className="panel__muted chord-explainer">
            {t("picker.chordExplainer")}
          </p>
          <div className="chord-preview">
            <span className="chord-preview__key">
              {(() => {
                const control = physicalControls.find((c) => c.id === controlId);
                return control ? displayNameForControl(control, "raw") : controlId;
              })()}
            </span>
            <span className="chord-preview__plus">+</span>
            <span className="chord-preview__key chord-preview__key--partner">
              {(() => {
                const partner = physicalControls.find((c) => c.id === chordPartner);
                return partner ? displayNameForControl(partner, "raw") : "…";
              })()}
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
                .map((c) => ({ value: c.id, label: displayNameForControl(c, "raw") })),
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
