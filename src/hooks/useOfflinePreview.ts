import { useEffect, useState } from "react";
import type { AppConfig } from "../lib/config";
import { getOfflinePreview } from "../lib/backend";
import type { OfflinePreview } from "../lib/onboard-mapping";

export function useOfflinePreview(config: AppConfig | null, profileId: string | null, deviceId: string | null): OfflinePreview | null {
  const [snapshot, setSnapshot] = useState<{
    config: AppConfig; profileId: string; deviceId: string; preview: OfflinePreview;
  } | null>(null);
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
  }, [config, profileId, deviceId]);
  // Old values are unknown immediately, including before the effect cleans up.
  return snapshot?.config === config && snapshot.profileId === profileId && snapshot.deviceId === deviceId
    ? snapshot.preview : null;
}
