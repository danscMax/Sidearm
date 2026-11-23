import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, Device, Profile } from "../lib/config";
import type { WorkspaceMode } from "../lib/constants";
import {
  getMouseSettings,
  listenActionExecutionEvent,
  listenMouseBattery,
  listenNativeMiceChanged,
  listNativeMice,
} from "../lib/backend";
import { deviceLayout } from "../lib/devices";
import { useDismissable } from "../hooks/useDismissable";
import type { MouseSettings, NativeModelInfo } from "../lib/onboard-mapping";

export type DeviceTab = "buttons" | "performance" | "memory" | "stats";

/** Live state of each connected built-in mouse, read on mount, on mouse
 *  events and when `refreshToken` changes (a write from the Performance or
 *  Memory views) — never on a timer, so the mice are not polled for a picture. */
function useMiceState(refreshToken: number): {
  /** null until the first list arrives. */
  mice: NativeModelInfo[] | null;
  readings: Map<string, MouseSettings | null>;
} {
  const [mice, setMice] = useState<NativeModelInfo[] | null>(null);
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

/** Universal sidebar device selector and device-scope navigation (`#2A`).
 *  Works for any input device (native mice with onboard memory/sensor telemetry
 *  as well as custom mice, macropads, keyboards, and other controllers). */
export function SidebarDeviceSection({
  config,
  devices,
  activeDeviceId,
  profile,
  refreshToken,
  workspaceMode,
  activeDeviceTab,
  onSelectDevice,
  onSelectDeviceTab,
  onAddDevice,
  onDeviceContextMenu,
}: {
  config: AppConfig;
  devices: Device[];
  activeDeviceId: string | null;
  profile: Profile | null;
  refreshToken: number;
  workspaceMode: WorkspaceMode;
  activeDeviceTab: DeviceTab;
  onSelectDevice: (id: string) => void;
  onSelectDeviceTab: (tab: DeviceTab) => void;
  onAddDevice: () => void;
  onDeviceContextMenu?: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const [selectToken, setSelectToken] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismissable(pickerRef, () => setMenuOpen(false));

  const { mice, readings } = useMiceState(refreshToken + selectToken);
  const isBuiltinNative = (device: Device) => Boolean(device.builtin && deviceLayout(device.id));
  const isConnected = (device: Device) => mice?.some((mouse) => mouse.deviceId === device.id) ?? false;
  const isFolded = (device: Device) => mice !== null && isBuiltinNative(device) && !isConnected(device);

  // On initial hardware list: move a default pick off an unplugged built-in mouse
  // to a connected one so the user lands directly on their active device.
  const placed = useRef(false);
  useEffect(() => {
    if (mice === null || placed.current) return;
    placed.current = true;
    const active = devices.find((device) => device.id === activeDeviceId);
    const connected = devices.find((device) => isBuiltinNative(device) && isConnected(device));
    if (active && isFolded(active) && connected) onSelectDevice(connected.id);
  }, [mice]);

  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? devices[0] ?? null;
  const activeBuiltin = activeDevice ? isBuiltinNative(activeDevice) : false;
  const activeConnected = activeDevice ? isConnected(activeDevice) : false;
  const activeReading = activeDevice ? readings.get(activeDevice.id) : undefined;
  const activeNativeInfo = activeDevice ? mice?.find((m) => m.deviceId === activeDevice.id) ?? null : null;

  const primaryDevices = devices.filter((device) => !isFolded(device));
  const offlineDevices = devices.filter((device) => isFolded(device));

  const deviceMetaText = (device: Device): string => {
    if (isBuiltinNative(device)) {
      if (!isConnected(device)) return t("device.notConnected");
      const reading = readings.get(device.id);
      const parts = [
        reading?.batteryPercent != null ? t("device.chipBattery", { percent: reading.batteryPercent }) : null,
        reading?.dpi != null ? t("device.chipDpi", { dpi: reading.dpi }) : null,
        reading?.pollRateHz != null ? t("device.chipPoll", { hz: reading.pollRateHz }) : null,
      ].filter((part): part is string => part !== null);
      if (parts.length > 0) return parts.join(" / ");
      return reading === undefined ? t("device.reading") : t("device.noAnswer");
    }
    const controls = config.physicalControls.filter((control) => control.deviceId === device.id).length;
    return t("device.chipControls", { count: controls });
  };

  const selectDevice = (device: Device) => {
    onSelectDevice(device.id);
    if (isBuiltinNative(device) && isConnected(device)) {
      setSelectToken((n) => n + 1);
    }
    setMenuOpen(false);
  };

  const isDeviceTabActive = (tab: DeviceTab) => workspaceMode === "profiles" && activeDeviceTab === tab;
  const activeSlot = activeDevice && activeBuiltin ? profile?.deviceSlots?.[activeDevice.id] : undefined;

  return (
    <div className="sidebar-device-zone">
      <div className="sidebar-device" ref={pickerRef}>
        <button
          type="button"
          className={`sidebar-device__btn${menuOpen ? " sidebar-device__btn--open" : ""}`}
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          aria-label={t("sidebar.selectDevice")}
          onClick={() => setMenuOpen((open) => !open)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (activeDevice) {
              if (activeBuiltin && activeConnected) setSelectToken((n) => n + 1);
              onDeviceContextMenu?.(e.clientX, e.clientY);
            }
          }}
        >
          <span className="sidebar-device__top">
            <span className="sidebar-device__name">
              {activeDevice ? activeDevice.name : t("app.deviceFallback")}
            </span>
            <span className="sidebar-device__chev" aria-hidden="true">▾</span>
          </span>
          <span className="sidebar-device__meta">
            {activeDevice ? deviceMetaText(activeDevice) : t("device.noneConnected")}
            {activeSlot !== undefined ? ` (${t("device.chipSlot", { n: activeSlot })})` : ""}
          </span>
        </button>

        {menuOpen ? (
          <div className="sidebar-device__menu" role="listbox" aria-label={t("device.cardsLabel")}>
            {primaryDevices.map((device) => {
              const selected = device.id === activeDevice?.id;
              return (
                <button
                  key={device.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`sidebar-device__option${selected ? " sidebar-device__option--active" : ""}`}
                  onClick={() => selectDevice(device)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selected) selectDevice(device);
                    else setMenuOpen(false);
                    onDeviceContextMenu?.(e.clientX, e.clientY);
                  }}
                >
                  <span className="sidebar-device__option-name">{device.name}</span>
                  <span className="sidebar-device__option-meta">{deviceMetaText(device)}</span>
                </button>
              );
            })}

            {offlineDevices.length > 0 ? (
              <>
                {primaryDevices.length > 0 ? <div className="sidebar-device__sep" role="separator" /> : null}
                <div className="sidebar-device__group-label">{t("device.offlineGroup")}</div>
                {offlineDevices.map((device) => {
                  const selected = device.id === activeDevice?.id;
                  return (
                    <button
                      key={device.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`sidebar-device__option sidebar-device__option--offline${selected ? " sidebar-device__option--active" : ""}`}
                      onClick={() => selectDevice(device)}
                    >
                      <span className="sidebar-device__option-name">{device.name}</span>
                      <span className="sidebar-device__option-meta">{t("device.notConnected")}</span>
                    </button>
                  );
                })}
              </>
            ) : null}

            <div className="sidebar-device__sep" role="separator" />
            <button
              type="button"
              className="sidebar-device__option sidebar-device__option--add"
              onClick={() => {
                setMenuOpen(false);
                onAddDevice();
              }}
            >
              <span className="sidebar-device__option-name">{t("device.addDevice")}</span>
              {primaryDevices.length === 0 ? (
                <span className="sidebar-device__option-meta">{t("device.noneConnected")}</span>
              ) : null}
            </button>
          </div>
        ) : null}
      </div>

      {activeDevice ? (
        <div className="sidebar__section sidebar__section--device">
          <div className="sidebar__section-header">
            <span className="sidebar__section-label">{t("sidebar.deviceHeader")}</span>
          </div>
          <nav className="sidebar-device__nav" aria-label={t("sidebar.deviceHeader")}>
            {activeBuiltin ? (
              <>
                <button
                  type="button"
                  aria-current={isDeviceTabActive("memory") ? "page" : undefined}
                  className={`nav-item nav-item--compact${isDeviceTabActive("memory") ? " nav-item--active" : ""}`}
                  onClick={() => onSelectDeviceTab("memory")}
                >
                  <svg className="nav-item__icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2.5" y="3" width="11" height="10" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M5.5 3v3.5h5V3M5.5 13V9.5h5V13" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                  <span className="nav-item__label">{t("device.tabMemory")}</span>
                  {activeNativeInfo?.banks ? (
                    <span className="sidebar-device__badge">{t("sidebar.slotsBadge", { max: 5 })}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-current={isDeviceTabActive("performance") ? "page" : undefined}
                  className={`nav-item nav-item--compact${isDeviceTabActive("performance") ? " nav-item--active" : ""}`}
                  onClick={() => onSelectDeviceTab("performance")}
                >
                  <svg className="nav-item__icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8.8 1.8L3.5 9h4.2l-.5 5.2L12.5 7H8.3l.5-5.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                  <span className="nav-item__label">{t("device.tabPerformance")}</span>
                  {activeConnected && activeReading?.dpi != null ? (
                    <span className="sidebar-device__badge">{activeReading.dpi}</span>
                  ) : null}
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-current={isDeviceTabActive("stats") ? "page" : undefined}
              className={`nav-item nav-item--compact${isDeviceTabActive("stats") ? " nav-item--active" : ""}`}
              onClick={() => onSelectDeviceTab("stats")}
            >
              <svg className="nav-item__icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 13V8.5M8 13V4M13 13V6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span className="nav-item__label">{t("device.tabStats")}</span>
            </button>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
