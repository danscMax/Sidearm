import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { changeLanguage } from "../../i18n";
import {
  type AdminAutostartStatus,
  getAdminAutostartStatus,
  getLiveMapReady,
  getSynapseStatus,
  isRunningAsAdmin,
  listenActionExecutionEvent,
  listenEncodedKeyEvent,
  listenNativeMiceChanged,
  listNativeMice,
  normalizeCommandError,
  recoverFromSynapse,
  relaunchAsAdmin,
  restoreOnboardControl,
  setAdminAutostart,
  setInputCaptureMode,
  startRuntime,
} from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import { deviceControlId, deviceLayout, layoutControlId, type DeviceLayout } from "../../lib/devices";
import { displayNameForControl, displayNameForControlId } from "../../lib/labels";
import type { NativeModelInfo } from "../../lib/onboard-mapping";
import type { ActionExecutionEvent, EncodedKeyEvent } from "../../lib/runtime";
import { NagaIllustration } from "./NagaIllustration";
import { ModalShell } from "../shared";
import "./onboarding.css";

type StepKey = "welcome" | "mouse" | "live" | "extras" | "admin" | "tryit";
type Lang = "ru" | "en";
type CheckState = "ok" | "warn" | "bad" | "pending";
type SynapseState = "pending" | "ok" | "running" | "unknown" | "closing";

/** How long the button check waits for the mouse before offering a way out. */
const READY_TIMEOUT_MS = 15_000;

interface OnboardingWizardProps {
  config: AppConfig;
  /** Persist a new config (parent wires this to the autosave/persistence hook). */
  applyConfig: (next: AppConfig) => void;
  /** Hide the wizard; `deviceId` is the mouse it set up, to show next. */
  onClose: (deviceId: string | null) => void;
}

/** The steps for a mouse: writing onboard memory only on the onboard path,
 *  the checks only for a verified model. */
export function wizardSteps(mouse: NativeModelInfo | null, layout: DeviceLayout | undefined): StepKey[] {
  const steps: StepKey[] = ["welcome"];
  if (mouse?.verified && layout) {
    if (!layout.firmwareTrigger) steps.push("mouse");
    steps.push("live");
    if (layout.checkedExtras.length > 0) steps.push("extras");
  }
  steps.push("admin", "tryit");
  return steps;
}

/** The side button (1–12) of `deviceId` a press came from, and whether its
 *  encoding is the hypershift layer's own (keyboard fallback), or null. */
export function thumbOf(config: AppConfig, deviceId: string, encodedKey: string): { button: number; hypershift: boolean } | null {
  const mapping = config.encoderMappings.find((item) =>
    item.encodedKey === encodedKey
    && config.physicalControls.some((control) => control.id === item.controlId && control.deviceId === deviceId));
  const match = /^thumb_(0[1-9]|1[0-2])$/.exec(layoutControlId(mapping?.controlId ?? ""));
  return match && mapping ? { button: Number(match[1]), hypershift: mapping.layer === "hypershift" } : null;
}

export function OnboardingWizard({ config, applyConfig, onClose }: OnboardingWizardProps) {
  const { t, i18n } = useTranslation();
  const lang: Lang = i18n.language?.startsWith("en") ? "en" : "ru";

  // Mice plugged in now; null until the first answer.
  const [mice, setMice] = useState<NativeModelInfo[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const mouse = mice?.find((item) => item.deviceId === chosen) ?? (mice?.length === 1 ? mice[0] : null);
  const deviceId = mouse?.deviceId ?? null;
  const layout = deviceLayout(deviceId);
  const steps = wizardSteps(mouse, layout);

  // By name: the step list depends on the mouse, which loads later. A saved
  // step means setup restarted as administrator from that step.
  const [stepKey, setStepKey] = useState<StepKey>(() => (config.settings.onboardingStep !== undefined ? "admin" : "welcome"));
  const stepIdx = Math.max(0, steps.indexOf(stepKey));
  const step = steps[stepIdx];
  // A step that no longer exists (its mouse was unplugged) is left for good.
  useEffect(() => {
    if (mice !== null && !steps.includes(stepKey)) setStepKey(steps[0]);
  });
  const testingButtons = step === "live" || step === "extras";

  const [synapse, setSynapse] = useState<SynapseState>("pending");
  const [synapseError, setSynapseError] = useState<string | null>(null);
  const [disableStartup, setDisableStartup] = useState(false);
  const [elevated, setElevated] = useState<CheckState>("pending");

  // Button check
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const readyRef = useRef(false);
  const [fullCheck, setFullCheck] = useState(false);
  const [detected, setDetected] = useState<Set<number>>(new Set());
  const [detectedShifted, setDetectedShifted] = useState<Set<number>>(new Set());
  const [detectedExtras, setDetectedExtras] = useState<Set<string>>(new Set());
  const [missedHold, setMissedHold] = useState<number | null>(null);
  const [lastShifted, setLastShifted] = useState(false);
  const [activeBtn, setActiveBtn] = useState<number | null>(null);
  const activeTimer = useRef<number | null>(null);

  const [mouseWritten, setMouseWritten] = useState(false);
  const [mouseWriteError, setMouseWriteError] = useState<string | null>(null);

  const [admin, setAdmin] = useState<AdminAutostartStatus | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);

  const [fired, setFired] = useState<ActionExecutionEvent | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const trigger = layout?.firmwareTrigger
    ? deviceControlId(layout, layout.firmwareTrigger)
    : config.settings.hypershiftTrigger === "none" ? null : config.settings.hypershiftTrigger ?? "mouse_right";
  // The device's own name for its trigger (the V3 names its ring button).
  const triggerControl = config.physicalControls.find((control) => control.id === trigger);
  const triggerName = !trigger ? "" : triggerControl ? displayNameForControl(triggerControl) : displayNameForControlId(trigger);
  const total = fullCheck ? 12 : 1;
  const standardCount = fullCheck ? detected.size : Number(detected.has(1));
  const shiftedCount = fullCheck ? detectedShifted.size : Number(detectedShifted.has(1));
  const checkingShifted = trigger !== null && standardCount === total;
  const confirmed = standardCount === total && (trigger === null || shiftedCount === total);
  const instruction = confirmed ? "confirmed"
    : checkingShifted ? (fullCheck ? "holdAll" : "holdOne") : (fullCheck ? "pressAll" : "pressOne");
  const extras = layout?.checkedExtras ?? [];

  const refreshMice = useCallback(async () => {
    try {
      setMice(await listNativeMice());
    } catch {
      setMice([]);
    }
  }, []);

  const checkSynapse = useCallback(async () => {
    setSynapse("pending");
    setSynapseError(null);
    try {
      setSynapse((await getSynapseStatus()).running ? "running" : "ok");
    } catch {
      setSynapse("unknown");
    }
  }, []);

  const closeSynapse = useCallback(async () => {
    setSynapse("closing");
    setSynapseError(null);
    try {
      // The recovery needs the runtime: it restores the mouse and restarts capture.
      await startRuntime();
      const result = await recoverFromSynapse(disableStartup, true);
      if (result.startupError) setSynapseError(normalizeCommandError(result.startupError).message);
      setSynapse((await getSynapseStatus()).running ? "running" : "ok");
    } catch (err) {
      setSynapseError(normalizeCommandError(err).message);
      setSynapse("running");
    }
  }, [disableStartup]);

  const receiveKey = useEffectEvent((e: EncodedKeyEvent) => {
    if (e.isKeyUp || !deviceId || !layout) return;
    // A press counts only from the chosen mouse once its map is verified: its
    // own HID stream, or the keyboard hook (F13–F24 mode), where only this
    // mouse's encodings match below.
    const fromMouse = e.backend.startsWith("hid:") ? e.backend === `hid:${deviceId}` : true;
    if (!readyRef.current || !fromMouse) return;
    if (step === "extras") {
      const mapping = config.encoderMappings.find((item) => item.layer === "standard" && item.encodedKey === e.encodedKey);
      const id = mapping ? layoutControlId(mapping.controlId) : null;
      if (id && !e.isHypershift && mapping && deviceControlId(layout, id) === mapping.controlId
        && extras.some(([extra]) => extra === id)) {
        setDetectedExtras((prev) => prev.has(id) ? prev : new Set([...prev, id]));
      }
      return;
    }
    const press = thumbOf(config, deviceId, e.encodedKey);
    if (press === null) return;
    const btn = press.button;
    const shifted = e.isHypershift === true || press.hypershift;
    if (fullCheck || btn === 1) setMissedHold(checkingShifted && !confirmed && !shifted ? btn : null);
    setLastShifted(shifted);
    setActiveBtn(btn);
    (shifted ? setDetectedShifted : setDetected)((prev) => prev.has(btn) ? prev : new Set([...prev, btn]));
    if (activeTimer.current) window.clearTimeout(activeTimer.current);
    activeTimer.current = window.setTimeout(() => setActiveBtn(null), 220);
  });

  // One-time: checks and live event subscriptions.
  useEffect(() => {
    let cancelled = false;
    const unlisten: (() => void)[] = [];
    const keep = (promise: Promise<() => void>) => {
      void promise.then((fn) => (cancelled ? fn() : unlisten.push(fn)))
        .catch((err) => !cancelled && setRuntimeError(normalizeCommandError(err).message));
    };
    void refreshMice();
    void checkSynapse();
    void isRunningAsAdmin()
      .then((ok) => !cancelled && setElevated(ok ? "ok" : "bad"))
      .catch(() => !cancelled && setElevated("bad"));
    void getAdminAutostartStatus()
      .then((status) => !cancelled && setAdmin(status))
      .catch((err) => !cancelled && setAdminError(normalizeCommandError(err).message));
    keep(listenNativeMiceChanged((next) => setMice(next)));
    keep(listenEncodedKeyEvent("encoded_key_received", (event) => receiveKey(event)));
    keep(listenActionExecutionEvent("action_executed", (event) => setFired(event)));
    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
      if (activeTimer.current) window.clearTimeout(activeTimer.current);
    };
  }, [refreshMice, checkSynapse]);

  // While the buttons are checked, actions do not run and the extra controls
  // join the live map; both end when the step does.
  const checkExtras = extras.length > 0;
  useEffect(() => {
    if (!testingButtons || !deviceId) return;
    let cancelled = false;
    let poll: number | undefined;
    const started = Date.now();
    const checkReady = async () => {
      const now = await getLiveMapReady(deviceId);
      if (cancelled) return;
      readyRef.current = now;
      setReady(now);
      if (!now && Date.now() - started > READY_TIMEOUT_MS) setTimedOut(true);
      poll = window.setTimeout(() => void checkReady().catch(reportError), 500);
    };
    const reportError = (err: unknown) => !cancelled && setRuntimeError(normalizeCommandError(err).message);
    readyRef.current = false;
    setReady(false);
    setTimedOut(false);
    setRuntimeError(null);
    void setInputCaptureMode(true, checkExtras)
      .then(() => startRuntime())
      .then(async () => {
        if (!cancelled) await checkReady();
      })
      .catch(reportError);
    return () => {
      cancelled = true;
      window.clearTimeout(poll);
      readyRef.current = false;
      void setInputCaptureMode(false, checkExtras).catch((err) => {
        console.error("Could not leave onboarding capture mode:", err);
      });
    };
  }, [testingButtons, deviceId, checkExtras, attempt]);

  // The finale needs the runtime for a real press.
  useEffect(() => {
    if (step !== "tryit") return;
    void startRuntime().catch((err) => setRuntimeError(normalizeCommandError(err).message));
  }, [step]);

  const finish = useCallback(() => {
    applyConfig({ ...config, settings: { ...config.settings, onboardingCompleted: true, onboardingStep: undefined } });
    onClose(deviceId);
  }, [config, applyConfig, onClose, deviceId]);

  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Move focus to the step heading so screen readers announce the new step.
    const heading = cardRef.current?.querySelector<HTMLElement>(".onb-step__title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [step, ready]);

  const goNext = () => (stepIdx >= steps.length - 1 ? finish() : setStepKey(steps[stepIdx + 1]));
  const goBack = () => setStepKey(steps[Math.max(0, stepIdx - 1)]);

  // Another mouse starts its checks from scratch.
  useEffect(() => {
    setDetected(new Set());
    setDetectedShifted(new Set());
    setDetectedExtras(new Set());
    setFullCheck(false);
    setMissedHold(null);
  }, [deviceId]);

  async function writeMouse() {
    setMouseWriteError(null);
    setMouseWritten(false);
    try {
      await restoreOnboardControl();
      setMouseWritten(true);
    } catch (err) {
      setMouseWriteError(normalizeCommandError(err).message);
    }
  }

  async function enableAdmin() {
    setAdminBusy(true);
    setAdminError(null);
    try {
      setAdmin(await setAdminAutostart(true));
    } catch (err) {
      setAdminError(normalizeCommandError(err).message);
    } finally {
      setAdminBusy(false);
    }
  }

  // The elevated instance reopens setup at this step.
  async function relaunch() {
    setRelaunchError(null);
    applyConfig({ ...config, settings: { ...config.settings, onboardingStep: steps.indexOf("admin") } });
    try {
      await relaunchAsAdmin();
    } catch (err) {
      setRelaunchError(normalizeCommandError(err).message);
    }
  }

  // Choosing between two mice is a question, not a problem; an unverified
  // model works, just without the checks.
  const mouseState: CheckState = mice === null || (mice.length > 1 && !mouse) ? "pending"
    : mouse?.verified ? "ok" : mouse ? "warn" : "bad";
  const nextDisabled =
    (step === "welcome" && (synapse === "pending" || synapse === "running" || synapse === "closing"
      || (mice !== null && mice.length > 1 && !chosen)));
  const skipping = (step === "live" && !confirmed) || (step === "extras" && detectedExtras.size < extras.length);
  const nextLabel = stepIdx === steps.length - 1 ? t("onboarding.finish")
    : step === "live" && !confirmed ? t("onboarding.check.skip")
      : step === "extras" && detectedExtras.size < extras.length ? t("onboarding.check.skipExtras")
        : t("onboarding.next");

  return (
    <ModalShell
      onClose={finish}
      backdropClassName="onb-overlay"
      className="onb-card"
      dialogRef={cardRef}
      ariaLabel={t("onboarding.ariaTitle")}
      dismissOnBackdropClick={false}
    >
      <div className="onb-header">
        <span className="onb-header__title">{t("onboarding.brand")}</span>
        <div className="onb-lang" role="group" aria-label={t("onboarding.ariaLanguage")}>
          {(["ru", "en"] as const).map((code) => (
            <button key={code} type="button" className={lang === code ? "is-active" : ""}
              aria-pressed={lang === code} onClick={() => changeLanguage(code)}>
              {code.toUpperCase()}
            </button>
          ))}
        </div>
        <button type="button" className="onb-skip" onClick={finish}>{t("onboarding.skip")}</button>
      </div>

      <ol className="onb-progress" aria-label={t("onboarding.ariaSteps")}>
        {steps.map((key, i) => (
          <li key={key}>
            <button
              type="button"
              aria-label={t("onboarding.stepLabel", { n: i + 1, total: steps.length, name: t(`onboarding.stepName.${key}`) })}
              aria-current={i === stepIdx ? "step" : undefined}
              disabled={i > stepIdx}
              className={`onb-dot ${i === stepIdx ? "is-current" : i < stepIdx ? "is-done" : ""}`}
              onClick={() => i < stepIdx && setStepKey(key)}
            />
          </li>
        ))}
      </ol>

      <div className="onb-body">
        <div className="onb-step" key={step}>
          {step === "welcome" && (
            <>
              <h2 className="onb-step__title">{t("onboarding.welcome.title")}</h2>
              <p className="onb-step__lead">{t("onboarding.welcome.lead")}</p>
              {mice !== null && mice.length > 1 && (
                <fieldset className="onb-choice">
                  <legend className="onb-step__section-title">{t("onboarding.device.choose")}</legend>
                  {mice.map((item) => (
                    <label key={item.deviceId} className={`onb-choice__option${chosen === item.deviceId ? " is-active" : ""}`}>
                      <input type="radio" name="onb-mouse" value={item.deviceId}
                        checked={chosen === item.deviceId} onChange={() => setChosen(item.deviceId)} />
                      <span>{item.name}</span>
                    </label>
                  ))}
                  <span className="panel__muted">{t("onboarding.device.later")}</span>
                </fieldset>
              )}
              <div className="onb-step__section-title">{t("onboarding.welcome.checks")}</div>
              <div className="onb-checks">
                <CheckRow
                  state={mouseState}
                  label={mouse ? mouse.name : t("onboarding.device.label")}
                  hint={mice === null ? t("onboarding.checkPending")
                    : !mouse ? t(mice.length > 1 ? "onboarding.device.pick" : "onboarding.device.none")
                      : mouse.verified ? t("onboarding.device.found") : t("onboarding.device.unverified")}
                  action={mice !== null && mice.length === 0 ? (
                    <button type="button" className="onb-check__action" onClick={() => void refreshMice()}>
                      {t("onboarding.retry")}
                    </button>
                  ) : undefined}
                />
                <CheckRow
                  state={synapse === "ok" ? "ok" : synapse === "running" ? "bad" : "pending"}
                  label={t("onboarding.synapse.label")}
                  hint={t(`onboarding.synapse.${synapse}`)}
                  action={synapse === "unknown" ? (
                    <button type="button" className="onb-check__action" onClick={() => void checkSynapse()}>
                      {t("onboarding.retry")}
                    </button>
                  ) : undefined}
                />
                <CheckRow
                  state={elevated === "bad" ? "warn" : elevated}
                  label={t("onboarding.welcome.cElevated")}
                  hint={t(elevated === "ok" ? "onboarding.checkOk" : elevated === "bad" ? "onboarding.welcome.elevatedHint" : "onboarding.checkPending")}
                />
              </div>
              {synapse === "running" && (
                <div className="onb-synapse" role="alert">
                  <p>{t("onboarding.synapse.explain")}</p>
                  <label className="onb-synapse__startup">
                    <input type="checkbox" checked={disableStartup} onChange={(e) => setDisableStartup(e.target.checked)} />
                    {t("onboarding.synapse.startup")}
                  </label>
                  <div className="onb-actions">
                    <button type="button" className="onb-btn primary" onClick={() => void closeSynapse()}>
                      {t("onboarding.synapse.close")}
                    </button>
                    <button type="button" className="onb-btn ghost" onClick={() => void checkSynapse()}>
                      {t("onboarding.retry")}
                    </button>
                  </div>
                </div>
              )}
              {synapseError && <div className="onb-result" role="alert">{synapseError}</div>}
              {mice !== null && mice.length === 0 && (
                <p className="onb-step__lead onb-step__lead--note">{t("onboarding.device.noneNote")}</p>
              )}
            </>
          )}

          {step === "mouse" && (
            <>
              <h2 className="onb-step__title">{t("onboarding.mouse.title")}</h2>
              <p className="onb-step__lead">{t("onboarding.mouse.lead")}</p>
              <div className="onb-actions">
                <button type="button" className="onb-btn primary" onClick={() => void writeMouse()}>
                  {t("onboarding.mouse.write")}
                </button>
              </div>
              {mouseWritten && <div className="onb-result"><span className="onb-check__dot ok" /> {t("onboarding.mouse.written")}</div>}
              {mouseWriteError && (
                <div className="onb-result" role="alert">
                  <span className="onb-check__dot bad" /> {t("onboarding.mouse.failed")}
                  <span className="panel__muted">{mouseWriteError}</span>
                </div>
              )}
            </>
          )}

          {testingButtons && !ready && (
            <>
              <h2 className="onb-step__title">{t(timedOut ? "onboarding.check.timeoutTitle" : "onboarding.check.preparingTitle")}</h2>
              <p className="onb-step__lead" role="status">
                {t(timedOut ? "onboarding.check.timeout" : "onboarding.check.preparing")}
              </p>
              {timedOut && (
                <div className="onb-actions">
                  <button type="button" className="onb-btn primary" onClick={() => setAttempt(attempt + 1)}>
                    {t("onboarding.retry")}
                  </button>
                </div>
              )}
              {runtimeError && <div className="onb-result" role="alert">{runtimeError}</div>}
            </>
          )}
          {step === "live" && ready && (
            <>
              <h2 className="onb-step__title">{t("onboarding.check.title")}</h2>
              <p className="onb-step__lead" role="status">{t(`onboarding.check.${instruction}`, { trigger: triggerName })}</p>
              {checkingShifted && !confirmed && missedHold !== null && (
                <div className="onb-result" role="status">{t("onboarding.check.missedHold", { button: missedHold, trigger: triggerName })}</div>
              )}
              <NagaIllustration
                detected={checkingShifted ? detectedShifted : detected}
                active={lastShifted === checkingShifted ? activeBtn : null}
                label={t("onboarding.ariaNaga")}
              />
              <div className="onb-live-readout" role="status">
                <div>{t("onboarding.check.standardProgress", { count: standardCount, total })}</div>
                {trigger && <div>{t("onboarding.check.heldProgress", { count: shiftedCount, total, trigger: triggerName })}</div>}
              </div>
              <button type="button" className="onb-btn ghost" onClick={() => {
                setFullCheck(!fullCheck);
                setMissedHold(null);
              }}>
                {t(fullCheck ? "onboarding.check.checkOne" : "onboarding.check.checkAll", { count: trigger ? 24 : 12 })}
              </button>
              {runtimeError && <div className="onb-result" role="alert">{runtimeError}</div>}
            </>
          )}
          {step === "extras" && ready && (
            <>
              <h2 className="onb-step__title">{t("onboarding.check.extrasTitle")}</h2>
              <p className="onb-step__lead">{t("onboarding.check.extrasLead", { trigger: triggerName })}</p>
              <p role="status">{t("onboarding.check.extrasProgress", { count: detectedExtras.size, total: extras.length })}</p>
              <div className="onb-checks onb-checks--extras">
                {extras.map(([id, label]) => {
                  const state = detectedExtras.has(id) ? "ok" : "pending";
                  return <CheckRow key={id} state={state} label={t(label)} hint={t(state === "ok" ? "onboarding.check.extraSeen" : "onboarding.check.extraWaiting")} />;
                })}
              </div>
              {runtimeError && <div className="onb-result" role="alert">{runtimeError}</div>}
            </>
          )}

          {step === "admin" && (
            <>
              <h2 className="onb-step__title">{t("onboarding.admin.title")}</h2>
              <p className="onb-step__lead">{t("onboarding.admin.lead")}</p>
              {elevated === "ok" ? (
                <div className="onb-result"><span className="onb-check__dot ok" /> {t("onboarding.admin.already")}</div>
              ) : (
                <>
                  {admin?.enabled && (
                    <div className="onb-result"><span className="onb-check__dot ok" /> {t("onboarding.admin.autostartConfigured")}</div>
                  )}
                  <div className="onb-actions">
                    {!admin?.enabled && (
                      <button type="button" className="onb-btn primary" onClick={() => void enableAdmin()} disabled={adminBusy}>
                        {adminBusy ? t("onboarding.admin.busy") : t("onboarding.admin.enable")}
                      </button>
                    )}
                    <button type="button" className={admin?.enabled ? "onb-btn primary" : "onb-btn ghost"} onClick={() => void relaunch()}>
                      {t("onboarding.admin.relaunch")}
                    </button>
                  </div>
                </>
              )}
              {relaunchError && <div className="onb-result" role="alert"><span className="onb-check__dot bad" /> {relaunchError}</div>}
              {adminError && <div className="onb-result" role="alert"><span className="onb-check__dot bad" /> {adminError}</div>}
              <p className="onb-step__lead onb-step__lead--note">{t("onboarding.admin.note")}</p>
            </>
          )}

          {step === "tryit" && (
            <>
              <h2 className="onb-step__title">{t("onboarding.tryit.title")}</h2>
              <p className="onb-step__lead">{t("onboarding.tryit.lead")}</p>
              {fired ? (
                <div className="onb-result">
                  <span className="onb-check__dot ok" />
                  {t("onboarding.tryit.fired")}: <strong className="onb-result__value">{fired.actionPretty}</strong>
                  {fired.resolvedProfileName ? ` (${fired.resolvedProfileName})` : ""}
                </div>
              ) : (
                <div className="onb-result is-pending">{t("onboarding.tryit.waiting")}</div>
              )}
              <div className="onb-actions">
                <button type="button" className="onb-btn ghost" onClick={finish}>{t("onboarding.tryit.assign")}</button>
              </div>
              {runtimeError && <div className="onb-result" role="alert">{runtimeError}</div>}
            </>
          )}
        </div>
      </div>

      <div className="onb-footer">
        <button type="button" className="onb-btn ghost" onClick={goBack} disabled={stepIdx === 0}>
          {t("onboarding.back")}
        </button>
        <div className="onb-spacer" />
        {/* Skipping a check is allowed but never the suggested action. */}
        <button type="button" className={skipping ? "onb-btn ghost" : "onb-btn primary"} onClick={goNext} disabled={nextDisabled}>
          {nextLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function CheckRow({ state, label, hint, action }: {
  state: CheckState;
  label: string;
  hint: string;
  /** Optional inline action shown next to the hint (e.g. a retry button). */
  action?: ReactNode;
}) {
  return (
    <div className="onb-check">
      <span className={`onb-check__dot ${state}`} aria-hidden="true" />
      <span className="onb-check__label">{label}</span>
      <span className="onb-check__hint">{hint}</span>
      {action}
    </div>
  );
}
