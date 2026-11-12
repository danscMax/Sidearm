import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, Layer } from "../lib/config";
import { displayNameForControlId, labelForLayer } from "../lib/labels";
import { compareProfiles } from "../lib/binding-moves";
import { ModalHeader, ModalShell, SelectField, SettingRow, Toggle } from "./shared";

const LAYERS: Layer[] = ["standard", "hypershift", "hypershift2", "hypershiftBoth"];

/** A button × profile table of one layer; rows that differ between profiles are marked. */
export function CompareProfilesModal({ config, layer, onClose }: { config: AppConfig; layer: Layer; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Layer>(layer);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const profiles = [...config.profiles].sort((a, b) => b.priority - a.priority);
  const rows = compareProfiles(config, shown, profiles.map((profile) => profile.id)).filter((row) => !onlyDiff || row.differs);

  return (
    <ModalShell onClose={onClose} className="transfer-modal compare-modal" dialogRef={ref} ariaLabelledby="compare-modal-title">
      <ModalHeader title={t("compare.title")} id="compare-modal-title" onClose={onClose} closeLabel={t("common.close")} />
      <div className="transfer-modal__body">
        <SettingRow title={t("compare.layer")}>
          <SelectField ariaLabel={t("compare.layer")} value={shown}
            options={LAYERS.map((value) => ({ value, label: labelForLayer(value) }))} onChange={setShown} />
        </SettingRow>
        <SettingRow title={t("compare.onlyDiff")}>
          <Toggle checked={onlyDiff} onChange={setOnlyDiff} ariaLabel={t("compare.onlyDiff")} />
        </SettingRow>
        {rows.length === 0 ? <p className="panel__muted">{t("compare.empty")}</p> : (
          <div className="compare-modal__scroll">
            <table className="compare-modal__table">
              <thead>
                <tr>
                  <th scope="col">{t("compare.button")}</th>
                  {profiles.map((profile) => <th scope="col" key={profile.id}>{profile.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.controlId} className={row.differs ? "compare-modal__row--diff" : undefined}>
                    <th scope="row">{displayNameForControlId(row.controlId)}</th>
                    {row.cells.map((cell, index) => (
                      <td key={profiles[index]!.id} className={cell ? undefined : "panel__muted"}>{cell || "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
