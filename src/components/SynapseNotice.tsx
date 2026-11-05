import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getSynapseStatus, listenOnboardTakeover, normalizeCommandError, openStartupAppsSettings,
  recoverFromSynapse, restoreSynapseStartup,
  type SynapseStatus,
} from "../lib/backend";
import type { OnboardTakeoverEvent } from "../lib/onboard-mapping";
import { Toast } from "./Toast";
import type { HypershiftTrigger } from "../lib/config";
import { recoveryTestInstruction } from "../lib/labels";

type Phase = "idle" | "repairing" | "test" | "confirmed";

/** One persistent card for every Razer takeover, including a late-opened window.
 * Polling observes external process changes; it never closes anything itself. */
export function SynapseNotice({ enabled, hypershiftTrigger = "mouse_right" }: { enabled: boolean; hypershiftTrigger?: HypershiftTrigger }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SynapseStatus>({ running: false, startupRestoreAvailable: false });
  const [takeover, setTakeover] = useState<OnboardTakeoverEvent | null>(null);
  const [disableStartup, setDisableStartup] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [startupWarning, setStartupWarning] = useState<string | null>(null);
  const [dismissedBackup, setDismissedBackup] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const poll = async () => {
      const current = generation.current;
      try {
        const next = await getSynapseStatus();
        if (disposed || current !== generation.current || busy.current) return;
        setStatus(next);
        setStatusError(null);
        if (next.running) setPhase("idle");
      } catch (e) {
        if (!disposed) setStatusError(normalizeCommandError(e).message);
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    // Listen immediately; snapshots recover process state even when startup events
    // were emitted before the webview existed. One state replaces toast queues.
    const unlisten = listenOnboardTakeover((event) => {
      if (disposed || busy.current) return;
      setTakeover(event);
      setPhase("idle");
      if (event.kind === "razerStarted") {
        setStatus((s) => ({ ...s, running: true }));
        setPhase("idle");
        setDisableStartup(false);
      }
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, [enabled]);

  async function repair() {
    if (busy.current) return;
    busy.current = true;
    generation.current += 1;
    setPhase("repairing");
    setError(null);
    setStartupWarning(null);
    try {
      // The backend rechecks a late Razer launch. A plain restore action never
      // gains permission to close an application just because its state changed.
      const result = await recoverFromSynapse(status.running && disableStartup, status.running);
      if (result.startupError) setStartupWarning(t("synapse.startupFailed", { reason: normalizeCommandError(result.startupError).message }));
      const next = await getSynapseStatus();
      setStatus(next);
      setDismissedBackup(false);
      setDisableStartup(false);
      setTakeover(null);
      if (next.running) throw new Error(t("synapse.restarted"));
      setPhase("test");
    } catch (e) {
      setError(normalizeCommandError(e).message);
      setPhase("idle");
    } finally {
      busy.current = false;
    }
  }

  async function undoStartup() {
    if (busy.current) return;
    const previousPhase = phase;
    busy.current = true;
    generation.current += 1;
    setPhase("repairing");
    setError(null);
    try {
      await restoreSynapseStartup();
      const next = await getSynapseStatus();
      setStatus(next);
      setStartupWarning(null);
      setPhase(next.running || takeover ? "idle" : previousPhase === "test" ? "test" : "confirmed");
    } catch (e) {
      setError(normalizeCommandError(e).message);
      setPhase(previousPhase === "test" ? "test" : "idle");
    } finally { busy.current = false; }
  }

  if (!enabled) return null;
  const conflict = status.running || takeover !== null;
  const visible = conflict || error || phase === "repairing" || phase === "test"
    || statusError || startupWarning || (status.startupRestoreAvailable && !dismissedBackup);
  if (!visible) return null;
  const message = phase === "repairing" ? t("synapse.repairing")
    : phase === "test" ? recoveryTestInstruction(hypershiftTrigger)
    : status.running ? t("synapse.conflict")
    : takeover ? t("synapse.mappingChanged")
    : error || statusError || startupWarning ? t("synapse.needsAttention")
    : status.startupRestoreAvailable ? t("synapse.startupDisabled") : t("synapse.confirmed");

  return (
    <Toast toast={{ id: 0, message, kind: phase === "test" || phase === "confirmed" ? "info" : "warning" }} onDismiss={() => {}}>
      <p className="toast__message">{message}</p>
      {status.running && phase === "idle" && <p className="panel__muted">{t("synapse.closeImpact")}</p>}
      {takeover && phase === "idle" && status.running && takeover.kind !== "razerStarted" && (
        <p className="panel__muted">{t(takeover.kind === "mode" ? "synapse.driverDetail" : "synapse.mappingDetail")}</p>
      )}
      {error && <p className="toast__error" role="alert">{t("synapse.failed", { reason: error })}</p>}
      {statusError && <p className="toast__error" role="alert">{t("synapse.statusUnknown", { reason: statusError })}</p>}
      {startupWarning && <p className="toast__error" role="alert">{startupWarning}</p>}
      {status.running && phase === "idle" && (
        <label className="toast__option">
          <input type="checkbox" checked={disableStartup} onChange={(e) => setDisableStartup(e.target.checked)} />
          {t("synapse.disableStartup")}
        </label>
      )}
      <div className="toast__buttons">
        {phase === "idle" && conflict && <button type="button" className="toast__action" onClick={() => { void repair(); }}>{t(status.running ? "synapse.repair" : "onboard.restoreAction")}</button>}
        {phase === "test" && <>
          <button type="button" className="toast__action" onClick={() => { setPhase("confirmed"); }}>{t("synapse.testPassed")}</button>
          <button type="button" className="toast__action" onClick={() => { setPhase("idle"); setError(t("synapse.testFailed")); setTakeover({ kind: "mode", restored: false, controls: [] }); }}>{t("synapse.testNotPassed")}</button>
        </>}
        {phase !== "repairing" && status.startupRestoreAvailable && <button type="button" className="toast__action" onClick={() => { void undoStartup(); }}>{t("synapse.undoStartup")}</button>}
        {phase !== "repairing" && (error || startupWarning) && <button type="button" className="toast__action" onClick={() => { void openStartupAppsSettings().catch((e: unknown) => setError(normalizeCommandError(e).message)); }}>{t("onboard.razerStartedAction")}</button>}
        {!conflict && phase === "confirmed" && <button type="button" className="toast__action" onClick={() => { setDismissedBackup(true); setStartupWarning(null); setError(null); }}>{t("synapse.dismiss")}</button>}
      </div>
    </Toast>
  );
}
