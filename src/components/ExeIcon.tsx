import { useEffect, useState } from "react";
import { getExeIcon } from "../lib/backend";

/** Module-level icon cache: exe name -> base64 PNG (or empty string for "no icon").
 *  Kept a single shared singleton so the icon for a given exe is fetched once,
 *  no matter how many cards / modals render it. */
const exeIconCache = new Map<string, string>();

/** Pending fetch promises to avoid duplicate concurrent requests. */
const exeIconPending = new Map<string, Promise<string | null>>();

/** First 2 uppercase letters of exe name (sans extension) for monogram icon. */
function exeMonogram(exe: string): string {
  const base = exe.replace(/\.exe$/i, "");
  return base.slice(0, 2).toUpperCase();
}

/** Renders an exe icon (fetched from backend) with monogram fallback. */
export function ExeIcon({ exe, processPath, className }: { exe: string; processPath?: string; className: string }) {
  const cacheKey = exe;
  const [iconSrc, setIconSrc] = useState<string | null>(() => {
    const cached = exeIconCache.get(cacheKey);
    return cached ? `data:image/png;base64,${cached}` : null;
  });

  useEffect(() => {
    if (exeIconCache.has(cacheKey)) {
      const v = exeIconCache.get(cacheKey)!;
      setIconSrc(v ? `data:image/png;base64,${v}` : null);
      return;
    }

    let cancelled = false;
    let pending = exeIconPending.get(cacheKey);
    if (!pending) {
      pending = getExeIcon(exe, processPath);
      exeIconPending.set(cacheKey, pending);
    }
    pending.then((b64) => {
      exeIconCache.set(cacheKey, b64 ?? "");
      exeIconPending.delete(cacheKey);
      if (!cancelled && b64) {
        setIconSrc(`data:image/png;base64,${b64}`);
      }
    }).catch(() => {
      exeIconCache.set(cacheKey, "");
      exeIconPending.delete(cacheKey);
    });
    return () => { cancelled = true; };
  }, [exe, processPath]);

  if (iconSrc) {
    return <img className={className} src={iconSrc} alt={exe} draggable={false} />;
  }
  return <span className={className}>{exeMonogram(exe)}</span>;
}
