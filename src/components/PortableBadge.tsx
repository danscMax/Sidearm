import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getAppPaths, openConfigFolder } from "../lib/backend";
import type { AppPathsInfo, PathMode } from "../lib/config";

export function PortableBadge() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppPathsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppPaths()
      .then((paths) => {
        if (!cancelled) {
          setInfo(paths);
          setError(null);
        }
      })
      .catch((error) => {
        console.error("getAppPaths failed:", error);
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) {
    return error ? (
      <span className="portable-badge portable-badge--fallback" title={error}>
        {t("portable.badge.error")}
      </span>
    ) : null;
  }

  const label = labelForMode(info.mode, t);
  const shortPath = truncateMiddle(info.configDir, 32);
  const tooltip = tooltipFor(info, t);

  return (
    <button
      type="button"
      className={`portable-badge portable-badge--${info.mode}`}
      onClick={() => {
        void openConfigFolder().catch((unknownError) => {
          setError(String(unknownError));
        });
      }}
      title={tooltip}
    >
      <span className="portable-badge__dot" aria-hidden="true" />
      <span className="portable-badge__label">{label}</span>
      <span className="portable-badge__path" aria-hidden="true">
        {shortPath}
      </span>
    </button>
  );
}

function labelForMode(
  mode: PathMode,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (mode) {
    case "portable":
      return t("portable.badge.portable");
    case "roaming":
      return t("portable.badge.roaming");
    case "portableFallback":
      return t("portable.badge.fallback");
  }
}

function tooltipFor(
  info: AppPathsInfo,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const parts = [t("portable.badge.tooltipPrefix"), info.configDir];
  if (info.fallbackReason) {
    parts.push(`\n${info.fallbackReason}`);
  }
  return parts.join(" ");
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(8, Math.floor((max - 3) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}
