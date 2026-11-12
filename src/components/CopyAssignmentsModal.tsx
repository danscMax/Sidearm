import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, Layer } from "../lib/config";
import { copyAssignments } from "../lib/binding-moves";
import { labelForLayer } from "../lib/labels";
import { PillTrack } from "./PillTrack";
import { ModalFooter, ModalHeader, ModalShell, SelectField, SettingRow } from "./shared";

const LAYERS: Layer[] = ["standard", "hypershift", "hypershift2", "hypershiftBoth"];

/** Copies a whole layer, or every layer of a profile, into another layer or profile. */
export function CopyAssignmentsModal({ config, profileId, layer, onApply, onClose }: {
  config: AppConfig;
  profileId: string;
  layer: Layer;
  onApply: (next: AppConfig, copied: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [fromLayer, setFromLayer] = useState<Layer | "all">(layer);
  const [toProfile, setToProfile] = useState(profileId);
  const [toLayer, setToLayer] = useState<Layer | "same">(layer === "hypershift2" ? "standard" : "hypershift2");
  const [replace, setReplace] = useState(false);

  // "All layers" lands on the same layers; copying a layer into itself needs another profile.
  const targetLayer = fromLayer === "all" ? "same" : toLayer;
  const result = copyAssignments(config, { profileId, layer: fromLayer }, { profileId: toProfile, layer: targetLayer }, replace);
  const layerOptions = LAYERS.map((value) => ({ value, label: labelForLayer(value) }));

  return (
    <ModalShell onClose={onClose} className="transfer-modal" dialogRef={ref} ariaLabelledby="copy-modal-title">
      <ModalHeader title={t("copyLayer.title")} id="copy-modal-title" onClose={onClose} closeLabel={t("common.close")} />
      <div className="transfer-modal__body">
        <SettingRow title={t("copyLayer.from")}>
          <SelectField ariaLabel={t("copyLayer.from")} value={fromLayer}
            options={[...layerOptions, { value: "all" as const, label: t("copyLayer.allLayers") }]}
            onChange={setFromLayer} />
        </SettingRow>
        <SettingRow title={t("copyLayer.toProfile")}>
          <SelectField ariaLabel={t("copyLayer.toProfile")} value={toProfile}
            options={config.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            onChange={setToProfile} />
        </SettingRow>
        {fromLayer !== "all" ? (
          <SettingRow title={t("copyLayer.toLayer")}>
            <SelectField ariaLabel={t("copyLayer.toLayer")} value={toLayer}
              options={[{ value: "same" as const, label: t("copyLayer.sameLayer") }, ...layerOptions]}
              onChange={setToLayer} />
          </SettingRow>
        ) : null}
        <SettingRow title={t("transfer.conflict")} hint={t("transfer.conflictHelp")}>
          <PillTrack
            items={[{ key: "keep" as const, label: t("transfer.keep") }, { key: "replace" as const, label: t("transfer.replace") }]}
            active={replace ? "replace" : "keep"}
            onSelect={(key) => setReplace(key === "replace")}
          />
        </SettingRow>
        <p role="status" className="transfer-modal__summary">
          {t("copyLayer.summary", { copied: result.copied, kept: result.kept })}
          {result.menus > 0 ? ` ${t("copyLayer.menusSkipped", { count: result.menus })}` : ""}
        </p>
      </div>
      <ModalFooter>
        <button type="button" className="action-button action-button--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="action-button" disabled={result.copied === 0}
          onClick={() => onApply(result.config, result.copied)}>
          {t("transfer.apply", { count: result.copied })}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
