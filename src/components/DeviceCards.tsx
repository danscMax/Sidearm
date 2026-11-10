import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, Device, Profile } from "../lib/config";
import {
  getMouseSettings,
  listenActionExecutionEvent,
  listenMouseBattery,
  listenNativeMiceChanged,
  listNativeMice,
} from "../lib/backend";
import { deviceLayout } from "../lib/devices";
import type { MouseSettings, NativeModelInfo } from "../lib/onboard-mapping";

/** Live state of each connected built-in mouse, read on mount, on mouse
 *  events and when `refreshToken` changes (a write from the Performance tab) —
 *  never on a timer, so the mice are not polled for a picture. */
function useMiceState(refreshToken: number): { mice: NativeModelInfo[]; readings: Map<string, MouseSettings | null> } {
  const [mice, setMice] = useState<NativeModelInfo[]>([]);
  // null: the mouse was asked and did not answer (asleep, out of range).
  const [readings, setReadings] = useState<Map<string, MouseSettings | null>>(new Map());
  useEffect(() => {
    let alive = true;
    const read = (list: NativeModelInfo[]) => {
      setMice(list);
      for (const mouse of list) {
        void getMouseSettings(mouse.deviceId).then(
          (value) => alive && setReadings((prev) => new Map(prev).set(mouse.deviceId, value)),
          () => alive && setReadings((prev) => new Map(prev).set(mouse.deviceId, null)),
        );
      }
    };
    const reload = () => void listNativeMice().then((list) => alive && read(list), () => {});
    reload();
    const disposers: (() => void)[] = [];
    const subscriptions = [
      listenNativeMiceChanged((list) => alive && read(list)),
      listenMouseBattery(reload),
      listenActionExecutionEvent("action_executed", (event) => {
        if (event.actionType === "mouseAction" && typeof event.summary === "object"
          && event.summary.key === "execution.dpiSwitched") reload();
      }),
    ];
    for (const subscription of subscriptions) {
      void subscription.then((dispose) => (alive ? disposers.push(dispose) : dispose()), () => {});
    }
    return () => {
      alive = false;
      disposers.forEach((dispose) => dispose());
    };
  }, [refreshToken]);
  return { mice, readings };
}

/** One card per device: the built-in mice with their battery, DPI, poll rate
 *  and the edited profile's slot; user devices with their button count. */
export function DeviceCards({
  config,
  devices,
  activeDeviceId,
  profile,
  refreshToken,
  onSelect,
  onAdd,
}: {
  config: AppConfig;
  devices: Device[];
  activeDeviceId: string | null;
  /** The edited profile: its slot on each mouse is shown. */
  profile: Profile | null;
  refreshToken: number;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  // Selecting a card reads that mouse again (it may have woken up since).
  const [selectToken, setSelectToken] = useState(0);
  const { mice, readings } = useMiceState(refreshToken + selectToken);
  return (
    <div className="device-cards" role="group" aria-label={t("device.cardsLabel")}>
      {devices.map((device) => {
        const builtin = device.builtin && deviceLayout(device.id) !== undefined;
        const connected = mice.some((mouse) => mouse.deviceId === device.id);
        const reading = readings.get(device.id);
        const slot = profile?.deviceSlots?.[device.id];
        const controls = config.physicalControls.filter((control) => control.deviceId === device.id).length;
        const values = builtin && connected
          ? [
              reading?.batteryPercent != null ? t("device.chipBattery", { percent: reading.batteryPercent }) : null,
              reading?.dpi != null ? t("device.chipDpi", { dpi: reading.dpi }) : null,
              reading?.pollRateHz != null ? t("device.chipPoll", { hz: reading.pollRateHz }) : null,
            ].filter((chip): chip is string => chip !== null)
          : [];
        const chips = builtin
          ? connected
            ? [
                ...(values.length > 0 ? values : [reading === undefined ? t("device.reading") : t("device.noAnswer")]),
                slot !== undefined ? t("device.chipSlot", { n: slot }) : null,
              ].filter((chip): chip is string => chip !== null)
            : [t("device.notConnected")]
          : [t("device.chipControls", { count: controls })];
        const active = device.id === activeDeviceId;
        return (
          <button
            key={device.id}
            type="button"
            aria-pressed={active}
            className={`device-card${active ? " device-card--active" : ""}${builtin && !connected ? " device-card--offline" : ""}`}
            onClick={() => {
              onSelect(device.id);
              if (builtin && connected) setSelectToken((n) => n + 1);
            }}
            title={device.name}
          >
            <span className="device-card__name">{device.name}</span>
            <span className="device-card__chips">
              {chips.map((chip) => <span key={chip} className="device-card__chip">{chip}</span>)}
            </span>
          </button>
        );
      })}
      <button type="button" className="device-card device-card--add" onClick={onAdd} title={t("device.addDeviceHint")}>
        <span className="device-card__name">{t("device.addDevice")}</span>
      </button>
    </div>
  );
}
