import { useTranslation } from "react-i18next";
import type { Device } from "../lib/config";
import { PillTrack } from "./PillTrack";

/** Device switcher above the visualization: pills per device + quiet "add".
 * Hidden entirely for the common single-device (Naga-only) setup except for
 * the add button, so existing users see almost no new chrome. */
export function DeviceBar({
  devices,
  activeDeviceId,
  onSelect,
  onAdd,
}: {
  devices: Device[];
  activeDeviceId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="device-bar">
      {devices.length > 1 && activeDeviceId ? (
        <PillTrack
          items={devices.map((device) => ({ key: device.id, label: device.name }))}
          active={activeDeviceId}
          onSelect={onSelect}
          className="device-bar__track"
        />
      ) : null}
      <button
        type="button"
        className="action-button action-button--small"
        onClick={onAdd}
        title={t("device.addDeviceHint")}
      >
        {t("device.addDevice")}
      </button>
    </div>
  );
}
