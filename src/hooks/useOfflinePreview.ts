import { useEffect, useState } from "react";
import type { AppConfig } from "../lib/config";
import { getOfflinePreview, listenMouseStatus, listenMouseBattery, listenNativeMiceChanged } from "../lib/backend";
import type { OfflinePreview } from "../lib/onboard-mapping";

export function useOfflinePreview(config: AppConfig | null, profileId: string | null, deviceId: string | null): OfflinePreview | null {
  const [hardwareVersion, setHardwareVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    config: AppConfig; profileId: string; deviceId: string; preview: OfflinePreview;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) setHardwareVersion((version) => version + 1); };
    const disposers: (() => void)[] = [];
    const subscriptions = [
      listenMouseStatus((event) => { if (event.kind === "mouseOffline") refresh(); }),
      listenMouseBattery(refresh),
      listenNativeMiceChanged(refresh),
    ];
    window.addEventListener("sidearm:banks-changed", refresh);
    for (const subscription of subscriptions) {
      void subscription.then((dispose) => { if (alive) disposers.push(dispose); else dispose(); },
        () => { if (alive) setSnapshot(null); });
    }
    return () => {
      alive = false;
      window.removeEventListener("sidearm:banks-changed", refresh);
      disposers.forEach((dispose) => dispose());
    };
  }, []);
  useEffect(() => {
    if (!config || !profileId || !deviceId) return;
    let stale = false;
    const timer = setTimeout(() => {
      getOfflinePreview(config, profileId, deviceId).then((preview) => {
        if (!stale) setSnapshot({ config, profileId, deviceId, preview });
      }).catch(() => {
        if (!stale) setSnapshot(null);
      });
    }, 150);
    return () => { stale = true; clearTimeout(timer); };
  }, [config, profileId, deviceId, hardwareVersion]);
  // Old values are unknown immediately, including before the effect cleans up.
  // A mouse event re-reads the hardware but keeps showing the last preview until
  // the new one arrives (no "unknown" flash on every battery report).
  return snapshot?.config === config && snapshot.profileId === profileId && snapshot.deviceId === deviceId
    ? snapshot.preview : null;
}
