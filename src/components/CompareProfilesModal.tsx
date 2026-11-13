import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, Layer } from "../lib/config";
import { displayNameForControlId, labelForLayer } from "../lib/labels";
import { compareMice, compareProfiles } from "../lib/binding-moves";
import { deviceLayout } from "../lib/devices";
import { PillTrack } from "./PillTrack";
import { ModalHeader, ModalShell, SelectField, SettingRow, Toggle } from "./shared";

const LAYERS: Layer[] = ["standard", "hypershift", "hypershift2", "hypershiftBoth"];

/** A button × profile table of one layer, or (two built-in mice) button place ×
 *  mouse of one profile; rows that differ are marked. */
export function CompareProfilesModal({ config, layer, profileId, onClose }: {
  config: AppConfig;
  layer: Layer;
  /** The profile the mice are compared in. */
  profileId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Layer>(layer);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const mice = config.devices.filter((device) => device.builtin && deviceLayout(device.id));
  const [mode, setMode] = useState<"profiles" | "mice">("profiles");
  const [profile, setProfile] = useState(profileId ?? config.profiles[0]?.id ?? "");
  const profiles = [...config.profiles].sort((a, b) => b.priority - a.priority);
  const byMouse = mode === "mice" && mice.length > 1;
  const columns = byMouse ? mice.map((mouse) => ({ id: mouse.id, name: mouse.name })) : profiles.map((p) => ({ id: p.id, name: p.name }));
  const rows = (byMouse
    ? compareMice(config, shown, profile, mice.map((mouse) => mouse.id)).map((row) => ({ key: row.place, ...row }))
    : compareProfiles(config, shown, profiles.map((p) => p.id)).map((row) => ({ key: row.controlId, ...row }))
  ).filter((row) => !onlyDiff || row.differs);

  return (
    <ModalShell onClose={onClose} className="transfer-modal compare-modal" dialogRef={ref} ariaLabelledby="compare-modal-title">
      <ModalHeader title={t("compare.title")} id="compare-modal-title" onClose={onClose} closeLabel={t("common.close")} />
      <div className="transfer-modal__body">
        {mice.length > 1 ? (
          <SettingRow title={t("compare.mode")}>
            <PillTrack
              items={[{ key: "profiles" as const, label: t("compare.modeProfiles") }, { key: "mice" as const, label: t("compare.modeMice") }]}
              active={mode}
              onSelect={setMode}
            />
          </SettingRow>
        ) : null}
        {byMouse ? (
          <SettingRow title={t("compare.profile")}>
            <SelectField ariaLabel={t("compare.profile")} value={profile}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))} onChange={setProfile} />
          </SettingRow>
        ) : null}
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
                  {columns.map((column) => <th scope="col" key={column.id}>{column.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={row.differs ? "compare-modal__row--diff" : undefined}>
                    <th scope="row">{displayNameForControlId(row.key)}</th>
                    {row.cells.map((cell, index) => (
                      <td key={columns[index]!.id} className={cell ? undefined : "panel__muted"}>{cell || "—"}</td>
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
