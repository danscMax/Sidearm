import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "../lib/config";
import { applyDeviceTransfer, applyHoldOffers, planDeviceTransfer, planHoldsFromHypershift2, type TransferConflict } from "../lib/device-transfer";
import { deviceLayout } from "../lib/devices";
import { controlWithGesture, displayNameForControlId, labelForLayer } from "../lib/labels";
import { PillTrack } from "./PillTrack";
import { ModalFooter, ModalHeader, ModalShell, SelectField, SettingRow, Toggle } from "./shared";

interface DeviceTransferModalProps {
  config: AppConfig;
  /** The mouse shown now: the default target. */
  activeDeviceId: string | null;
  activeProfileId: string | null;
  /** Start with every profile selected (a new mouse takes them all). */
  allProfiles?: boolean;
  onApply: (next: AppConfig, copied: number) => void;
  /** Turns "keep the mice alike" on or off at once (`settings.syncMice`). */
  onSyncChange: (on: boolean) => void;
  onClose: () => void;
}

/** Copies assignments from one built-in mouse to another, with a preview of
 *  what is copied and what is left out. */
export function DeviceTransferModal({ config, activeDeviceId, activeProfileId, allProfiles, onApply, onSyncChange, onClose }: DeviceTransferModalProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const mice = config.devices.filter((device) => device.builtin && deviceLayout(device.id));
  const [to, setTo] = useState(mice.find((device) => device.id === activeDeviceId)?.id ?? mice[mice.length - 1]?.id ?? "");
  const [from, setFrom] = useState(mice.find((device) => device.id !== to)?.id ?? "");
  const [scope, setScope] = useState<"profile" | "all">(activeProfileId && !allProfiles ? "profile" : "all");
  const [conflict, setConflict] = useState<TransferConflict>("keep");
  const [shareMenus, setShareMenus] = useState(false);
  // HyperShift 2 of the source mouse → long presses of a mouse without it.
  const [chosenHolds, setChosenHolds] = useState<Set<string>>(new Set());

  const profileIds = scope === "all" || !activeProfileId ? config.profiles.map((profile) => profile.id) : [activeProfileId];
  const plan = from && to && from !== to ? planDeviceTransfer(config, from, to, profileIds, conflict) : [];
  const copied = plan.filter((item) => item.outcome === "copy" || item.outcome === "replace");
  const skipped = plan.filter((item) => item.outcome === "noMatch" || item.outcome === "noLayer" || item.outcome === "occupied");
  const options = mice.map((device) => ({ value: device.id, label: device.name }));
  const holdOffers = from && to && from !== to ? planHoldsFromHypershift2(config, from, to, profileIds) : [];
  const toggleHold = (id: string) => setChosenHolds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const profileName = (id: string) => config.profiles.find((profile) => profile.id === id)?.name ?? id;

  return (
    <ModalShell onClose={onClose} className="transfer-modal" dialogRef={ref} ariaLabelledby="transfer-modal-title">
      <ModalHeader title={t("transfer.title")} id="transfer-modal-title" onClose={onClose} closeLabel={t("common.close")} />
      <div className="transfer-modal__body">
        <p className="panel__muted">{t("transfer.lead")}</p>
        <SettingRow title={t("transfer.from")}>
          <SelectField ariaLabel={t("transfer.from")} value={from} options={options}
            onChange={(id) => { setFrom(id); if (id === to) setTo(mice.find((device) => device.id !== id)?.id ?? ""); }} />
        </SettingRow>
        <SettingRow title={t("transfer.to")}>
          <SelectField ariaLabel={t("transfer.to")} value={to} options={options.filter((option) => option.value !== from)}
            onChange={setTo} />
        </SettingRow>
        <SettingRow title={t("transfer.scope")}>
          <PillTrack
            items={[
              ...(activeProfileId ? [{ key: "profile" as const, label: t("transfer.scopeProfile", { name: profileName(activeProfileId) }) }] : []),
              { key: "all" as const, label: t("transfer.scopeAll") },
            ]}
            active={scope}
            onSelect={setScope}
          />
        </SettingRow>
        <SettingRow title={t("transfer.conflict")} hint={t("transfer.conflictHelp")}>
          <PillTrack
            items={[
              { key: "keep" as const, label: t("transfer.keep") },
              { key: "replace" as const, label: t("transfer.replace") },
            ]}
            active={conflict}
            onSelect={setConflict}
          />
        </SettingRow>
        <SettingRow title={t("transfer.shareMenus")} hint={t("transfer.shareMenusHelp")}>
          <Toggle checked={shareMenus} onChange={setShareMenus} ariaLabel={t("transfer.shareMenus")} />
        </SettingRow>
        <SettingRow title={t("transfer.syncMice")} hint={t("transfer.syncMiceHelp")}>
          <Toggle checked={config.settings.syncMice ?? false} onChange={onSyncChange} ariaLabel={t("transfer.syncMice")} />
        </SettingRow>
        <p role="status" className="transfer-modal__summary">
          {plan.length === 0 ? t("transfer.nothing") : t("transfer.summary", { copied: copied.length, skipped: skipped.length })}
        </p>
        {holdOffers.length > 0 ? (
          <details className="transfer-modal__holds">
            <summary>{t("transfer.holdsTitle", { count: holdOffers.length })}</summary>
            <p className="panel__muted">{t("transfer.holdsHelp")}</p>
            <ul className="transfer-modal__list">
              {holdOffers.map((offer) => (
                <li key={offer.binding.id}>
                  <label className="transfer-modal__hold">
                    <input type="checkbox" checked={chosenHolds.has(offer.binding.id)} onChange={() => toggleHold(offer.binding.id)} />
                    {offer.binding.label} → {controlWithGesture(offer.target, "longPress")}
                    {scope === "all" ? <span className="panel__muted"> · {profileName(offer.binding.profileId)}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
            <button type="button" className="action-button action-button--secondary" disabled={chosenHolds.size === 0}
              onClick={() => onApply(applyHoldOffers(config, holdOffers.filter((offer) => chosenHolds.has(offer.binding.id))), chosenHolds.size)}>
              {t("transfer.holdsApply", { count: chosenHolds.size })}
            </button>
          </details>
        ) : null}
        {skipped.length > 0 && (
          <details>
            <summary>{t("transfer.skippedDetails")}</summary>
            <ul className="transfer-modal__list">
              {skipped.map(({ binding, outcome }) => (
                <li key={binding.id}>
                  {binding.label || displayNameForControlId(binding.controlId)} · {displayNameForControlId(binding.controlId)} · {labelForLayer(binding.layer)}
                  {scope === "all" ? ` · ${profileName(binding.profileId)}` : ""}
                  <span className="panel__muted"> — {t(outcome === "occupied" ? "transfer.reasonOccupied" : outcome === "noLayer" ? "transfer.reasonNoLayer" : "transfer.reasonNoMatch")}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <ModalFooter>
        <button type="button" className="action-button action-button--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="action-button" disabled={copied.length === 0}
          onClick={() => onApply(applyDeviceTransfer(config, from, to, plan, { shareMenus }), copied.length)}>
          {t("transfer.apply", { count: copied.length })}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
