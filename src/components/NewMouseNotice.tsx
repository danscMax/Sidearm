import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listNativeMice, listenNativeMiceChanged } from "../lib/backend";
import type { AppConfig } from "../lib/config";
import type { NativeModelInfo } from "../lib/onboard-mapping";
import { newMouseNotice } from "../lib/devices";
import { Toast } from "./Toast";

const DISMISSED_KEY = "sidearm.newMouseNotice.dismissed";

function dismissedIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A connected mouse with no assignments yet: offers to copy another mouse's
 *  assignments or to run the setup. Shown once per mouse until acted on. */
export function NewMouseNotice({ config, onCopy, onSetup }: {
  config: AppConfig | null;
  onCopy: (deviceId: string) => void;
  onSetup: () => void;
}) {
  const { t } = useTranslation();
  const [mice, setMice] = useState<NativeModelInfo[]>([]);
  const [dismissed, setDismissed] = useState(dismissedIds);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listNativeMice().then((list) => alive && setMice(list), () => {});
    void listenNativeMiceChanged((list) => alive && setMice(list)).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const notice = config ? newMouseNotice(config, mice.filter((mouse) => mouse.verified).map((mouse) => mouse.deviceId), dismissed) : null;
  if (!notice) return null;

  const dismiss = () => {
    const next = [...dismissed, notice.device.id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the notice comes back next start, nothing else breaks.
    }
  };

  return (
    <Toast toast={{ id: 0, message: "", kind: "info" }} onDismiss={dismiss}>
      <p>{t("newMouse.message", { name: notice.device.name })}</p>
      <div className="toast__buttons">
        {notice.copyFrom ? (
          <button type="button" className="toast__action" onClick={() => { dismiss(); onCopy(notice.device.id); }}>
            {t("newMouse.copy", { name: notice.copyFrom.name })}
          </button>
        ) : null}
        <button type="button" className="toast__action" onClick={() => { dismiss(); onSetup(); }}>
          {t("newMouse.setup")}
        </button>
        <button type="button" className="toast__action" onClick={dismiss}>
          {t("newMouse.later")}
        </button>
      </div>
    </Toast>
  );
}
