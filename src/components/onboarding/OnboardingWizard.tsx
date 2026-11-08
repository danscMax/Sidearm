import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { changeLanguage } from "../../i18n";
import {
  type AdminAutostartStatus,
  checkSynapseInstalled,
  getAdminAutostartStatus,
  isRunningAsAdmin,
  listenActionExecutionEvent,
  listenEncodedKeyEvent,
  normalizeCommandError,
  relaunchAsAdmin,
  restoreOnboardControl,
  setAdminAutostart,
  setInputCaptureMode,
  startRuntime,
} from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import { usesNagaV3Ring } from "../../lib/onboard-mapping";
import type { ActionExecutionEvent, EncodedKeyEvent } from "../../lib/runtime";
import { NagaIllustration } from "./NagaIllustration";
import { ModalShell } from "../shared";
import "./onboarding.css";

type StepKey = "welcome" | "mouse" | "live" | "admin" | "tryit";
const STEPS: StepKey[] = ["welcome", "mouse", "live", "admin", "tryit"];
const NAGA_V3_STEPS: StepKey[] = ["welcome", "live", "tryit"];

type Lang = "ru" | "en";
type CheckState = "ok" | "bad" | "pending";

interface OnboardingWizardProps {
  config: AppConfig;
  /** Persist a new config (parent wires this to the autosave/persistence hook). */
  applyConfig: (next: AppConfig) => void;
  /** Hide the wizard. */
  onClose: () => void;
}

/** Map a bare F-key string (F13..F24) to a 1-based Naga button number, or null. */
function fkeyToButton(encodedKey: string): number | null {
  const m = /^F(\d{1,2})$/.exec(encodedKey.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 13 && n <= 24) return n - 12;
  return null;
}

export function OnboardingWizard({ config, applyConfig, onClose }: OnboardingWizardProps) {
  const { t, i18n } = useTranslation();
  const lang: Lang = i18n.language?.startsWith("en") ? "en" : "ru";
  // Onboarding copy lives in locales/{ru,en}.json under `onboarding.*` (single
  // source of truth). Pull the whole nested block as one object so the JSX below
  // keeps its `T.section.key` shape; re-resolves on language switch.
  const T = t("onboarding", { returnObjects: true }) as unknown as Copy;
  const nagaV3 = usesNagaV3Ring(config);
  const steps = nagaV3 ? NAGA_V3_STEPS : STEPS;

  const [stepIdx, setStepIdx] = useState(0);
  const step = steps[stepIdx];

  // Pre-flight. "ok" = Razer Synapse is neither installed nor running: Sidearm
  // writes the mouse itself, and a running Synapse rewrites the buttons.
  const [synapseOk, setSynapseOk] = useState<CheckState>("pending");
  const [elevated, setElevated] = useState<CheckState>("pending");

  // Live test
  const [detected, setDetected] = useState<Set<number>>(new Set());
  const [detectedShifted, setDetectedShifted] = useState<Set<number>>(new Set());
  const [lastShifted, setLastShifted] = useState(false);
  const [fullCheck, setFullCheck] = useState(false);
  const liveVerification = useRef(false);
  const [activeBtn, setActiveBtn] = useState<number | null>(null);
  const [lastButton, setLastButton] = useState<number | null>(null);
  const activeTimer = useRef<number | null>(null);

  // "Write to the mouse" on the mouse step
  const [mouseWritten, setMouseWritten] = useState(false);
  const [mouseWriteError, setMouseWriteError] = useState<string | null>(null);

  // Admin
  const [admin, setAdmin] = useState<AdminAutostartStatus | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);

  // Finale
  const [fired, setFired] = useState<ActionExecutionEvent | null>(null);
  const [runtimeSetupError, setRuntimeSetupError] = useState<string | null>(null);

  // --- one-time setup: start runtime, run checks, subscribe to live events ---
  useEffect(() => {
    let unlistenKey: (() => void) | null = null;
    let unlistenAction: (() => void) | null = null;
    let cancelled = false;

    void startRuntime()
      .then(() => !cancelled && setRuntimeSetupError(null))
      .catch((err) => !cancelled && setRuntimeSetupError(normalizeCommandError(err).message));
    if (!nagaV3) {
      void checkSynapseInstalled()
        .then((present) => !cancelled && setSynapseOk(present ? "bad" : "ok"))
        .catch(() => !cancelled && setSynapseOk("bad"));
      void isRunningAsAdmin()
        .then((ok) => !cancelled && setElevated(ok ? "ok" : "bad"))
        .catch(() => !cancelled && setElevated("bad"));
      void getAdminAutostartStatus()
        .then((s) => !cancelled && setAdmin(s))
        .catch((err) => !cancelled && setAdminError(normalizeCommandError(err).message));
    }

    void listenEncodedKeyEvent("encoded_key_received", (e: EncodedKeyEvent) => {
      if (e.isKeyUp) return;
      if (nagaV3 && (!liveVerification.current || e.backend !== "windows-hid-naga-v3")) return;
      const control = nagaV3
        ? config.encoderMappings.find((item) => item.layer === "standard" && item.encodedKey === e.encodedKey)
        : undefined;
      const btn = nagaV3
        ? Number(/^v3_thumb_(0[1-9]|1[0-2])$/.exec(control?.controlId ?? "")?.[1]) || null
        : fkeyToButton(e.encodedKey);
      if (btn === null) return;
      const shifted = nagaV3 && e.isHypershift === true;
      setLastShifted(shifted);
      setActiveBtn(btn);
      setLastButton(btn);
      const mark = shifted ? setDetectedShifted : setDetected;
      mark((prev) => {
        if (prev.has(btn)) return prev;
        const next = new Set(prev);
        next.add(btn);
        return next;
      });
      if (activeTimer.current) window.clearTimeout(activeTimer.current);
      activeTimer.current = window.setTimeout(() => setActiveBtn(null), 220);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenKey = fn;
      })
      .catch((err) => !cancelled && setRuntimeSetupError(normalizeCommandError(err).message));

    void listenActionExecutionEvent("action_executed", (e: ActionExecutionEvent) => {
      setFired(e);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenAction = fn;
      })
      .catch((err) => !cancelled && setRuntimeSetupError(normalizeCommandError(err).message));

    return () => {
      cancelled = true;
      unlistenKey?.();
      unlistenAction?.();
      if (activeTimer.current) window.clearTimeout(activeTimer.current);
    };
  }, []);

  // While the live hardware-test step is open, suppress real action execution
  // so pressing Naga buttons only lights up the tester (no search/delete/etc.).
  // Always cleared when leaving the step or unmounting.
  useEffect(() => {
    const inLive = step === "live";
    liveVerification.current = inLive;
    void setInputCaptureMode(inLive);
    return () => {
      if (inLive) {
        liveVerification.current = false;
        void setInputCaptureMode(false);
      }
    };
  }, [step]);

  const complete = useCallback(() => {
    applyConfig({ ...config, settings: { ...config.settings, onboardingCompleted: true } });
    onClose();
  }, [config, applyConfig, onClose]);

  // Keyboard containment + Escape-to-skip handled by ModalShell.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On each step change, move focus to that step's heading so screen readers
    // announce the new step (the SPA route-change pattern). Headings aren't
    // focusable by default, so make the current one programmatically focusable.
    const heading = cardRef.current?.querySelector<HTMLElement>(".onb-step__title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [stepIdx]);

  const goNext = useCallback(() => {
    // Keep the setState updater pure: decide from the current index in the
    // closure and run the side effect (complete()) outside it, so StrictMode's
    // double-invoked updater can't fire complete() twice.
    if (stepIdx >= steps.length - 1) {
      complete();
    } else {
      setStepIdx((i) => i + 1);
    }
  }, [stepIdx, steps.length, complete]);
  const goBack = useCallback(() => setStepIdx((i) => Math.max(0, i - 1)), []);

  const writeMouse = useCallback(async () => {
    setMouseWriteError(null);
    setMouseWritten(false);
    try {
      await restoreOnboardControl();
      setMouseWritten(true);
    } catch (err) {
      setMouseWriteError(normalizeCommandError(err).message);
    }
  }, []);

  const toggleAdmin = useCallback(async () => {
    setAdminBusy(true);
    setAdminError(null);
    try {
      // Enabling autostart only registers the scheduled task — it does NOT
      // elevate the current session, so `elevated` stays as-is (the welcome
      // check only flips to OK after an actual elevated relaunch / next logon).
      const next = await setAdminAutostart(true);
      setAdmin(next);
    } catch (err) {
      setAdminError(normalizeCommandError(err).message);
    } finally {
      setAdminBusy(false);
    }
  }, []);

  // Relaunch the current session elevated. On success the process exits and a
  // new elevated one starts; onboarding reopens (flag still false) with the
  // admin check green. Only the UAC-declined / failure path returns here.
  const handleRelaunch = useCallback(async () => {
    setRelaunchError(null);
    try {
      await relaunchAsAdmin();
    } catch (err) {
      setRelaunchError(normalizeCommandError(err).message);
    }
  }, []);

  const detectedCount = detected.size;
  const v3Confirmed = fullCheck
    ? detected.size === 12 && detectedShifted.size === 12
    : detected.has(1) && detectedShifted.has(1);

  const readiness = useMemo<CheckState>(() => {
    if (synapseOk === "pending" || elevated === "pending") return "pending";
    return synapseOk === "ok" ? "ok" : "bad";
  }, [synapseOk, elevated]);

  return (
    <ModalShell
      onClose={complete}
      backdropClassName="onb-overlay"
      className="onb-card"
      dialogRef={cardRef}
      ariaLabel={T.ariaTitle}
      dismissOnBackdropClick={false}
    >
        <div className="onb-header">
          <span className="onb-header__title">{T.brand}</span>
          <div className="onb-lang" role="group" aria-label={T.ariaLanguage}>
            <button
              type="button"
              className={lang === "ru" ? "is-active" : ""}
              onClick={() => changeLanguage("ru")}
            >
              RU
            </button>
            <button
              type="button"
              className={lang === "en" ? "is-active" : ""}
              onClick={() => changeLanguage("en")}
            >
              EN
            </button>
          </div>
          <button type="button" className="onb-skip" onClick={complete}>
            {T.skip}
          </button>
        </div>

        <div className="onb-progress" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={stepIdx + 1}>
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-label={`${i + 1}/${steps.length}`}
              aria-current={i === stepIdx ? "step" : undefined}
              disabled={i > stepIdx}
              className={`onb-dot ${i === stepIdx ? "is-current" : i < stepIdx ? "is-done" : ""}`}
              onClick={() => i < stepIdx && setStepIdx(i)}
            />
          ))}
        </div>

        <div className="onb-body">
          <div className="onb-step" key={step}>
            {step === "welcome" && nagaV3 && (
              <>
                <h2 className="onb-step__title">Razer Naga V3 Pro</h2>
                <p className="onb-step__lead">{t("onboarding.v3.welcome")}</p>
              </>
            )}
            {step === "welcome" && !nagaV3 && (
              <>
                <h2 className="onb-step__title">{T.welcome.title}</h2>
                <p className="onb-step__lead">{T.welcome.lead}</p>
                <div className="onb-step__section-title">{T.welcome.checks}</div>
                <div className="onb-checks">
                  <CheckRow
                    state={synapseOk}
                    label={T.welcome.cSynapse}
                    hint={synapseOk === "bad" ? T.welcome.synapseHint : hintFor(synapseOk, T)}
                  />
                  <CheckRow
                    state={elevated}
                    label={T.welcome.cElevated}
                    hint={hintFor(elevated, T)}
                    action={
                      elevated === "bad" ? (
                        <button
                          type="button"
                          className="onb-check__action"
                          onClick={() => void handleRelaunch()}
                        >
                          {T.welcome.relaunch}
                        </button>
                      ) : undefined
                    }
                  />
                  <CheckRow state={readiness} label={T.welcome.cNaga} hint={T.welcome.nagaHint} />
                </div>
                {relaunchError ? (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {relaunchError}
                  </div>
                ) : null}
              </>
            )}

            {step === "mouse" && (
              <>
                <h2 className="onb-step__title">{T.mouse.title}</h2>
                <p className="onb-step__lead">{T.mouse.lead}</p>
                <ol className="onb-steps-list">
                  <li>{T.mouse.s1}</li>
                  <li>{T.mouse.s2}</li>
                </ol>
                <div className="onb-actions">
                  <button type="button" className="onb-btn primary" onClick={() => void writeMouse()}>
                    {T.mouse.write}
                  </button>
                </div>
                {mouseWritten && (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" /> {T.mouse.written}
                  </div>
                )}
                {mouseWriteError && (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {mouseWriteError}
                  </div>
                )}
              </>
            )}

            {step === "live" && nagaV3 && (
              <>
                <h2 className="onb-step__title">{t("onboarding.v3.check")}</h2>
                <p className="onb-step__lead">{t(fullCheck ? "onboarding.v3.full" : "onboarding.v3.quick")}</p>
                <NagaIllustration detected={lastShifted ? detectedShifted : detected} active={activeBtn} label={T.ariaNaga} />
                <div className="onb-live-readout" role="status">
                  {t("onboarding.v3.progress", {
                    count: fullCheck ? detected.size + detectedShifted.size : Number(detected.has(1)) + Number(detectedShifted.has(1)),
                    total: fullCheck ? 24 : 2,
                  })}
                </div>
                {!fullCheck && <button type="button" className="onb-btn ghost" onClick={() => setFullCheck(true)}>
                  {t("onboarding.v3.checkAll")}
                </button>}
                {runtimeSetupError && <div className="onb-result" role="alert">{runtimeSetupError}</div>}
              </>
            )}
            {step === "live" && !nagaV3 && (
              <>
                <h2 className="onb-step__title">{T.live.title}</h2>
                <p className="onb-step__lead">{T.live.lead}</p>
                <NagaIllustration detected={detected} active={activeBtn} label={T.ariaNaga} />
                <div className="onb-live-readout">
                  {lastButton !== null ? (
                    <>
                      {T.live.last} <strong>{lastButton}</strong> — {detectedCount}/12
                    </>
                  ) : (
                    T.live.waiting
                  )}
                </div>
                {detectedCount >= 12 && (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" /> {T.live.allDone}
                  </div>
                )}
                {runtimeSetupError ? (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {runtimeSetupError}
                  </div>
                ) : null}
              </>
            )}

            {step === "admin" && (
              <>
                <h2 className="onb-step__title">{T.admin.title}</h2>
                <p className="onb-step__lead">{T.admin.lead}</p>
                {elevated === "ok" ? (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" /> {T.admin.already}
                  </div>
                ) : admin?.enabled ? (
                  <>
                    <div className="onb-result">
                      <span className="onb-check__dot ok" /> {T.admin.autostartConfigured}
                    </div>
                    <div className="onb-actions">
                      <button type="button" className="onb-btn primary" onClick={() => void handleRelaunch()}>
                        {T.admin.relaunch}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="onb-actions">
                    <button
                      type="button"
                      className="onb-btn primary"
                      onClick={() => void toggleAdmin()}
                      disabled={adminBusy}
                    >
                      {adminBusy ? T.admin.busy : T.admin.enable}
                    </button>
                    <button type="button" className="onb-btn ghost" onClick={() => void handleRelaunch()}>
                      {T.admin.relaunch}
                    </button>
                  </div>
                )}
                {relaunchError ? (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {relaunchError}
                  </div>
                ) : null}
                {adminError ? (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {adminError}
                  </div>
                ) : null}
                <p className="onb-step__lead onb-step__lead--note">
                  {T.admin.note}
                </p>
              </>
            )}

            {step === "tryit" && nagaV3 && (
              <>
                <h2 className="onb-step__title">{t("onboarding.v3.ready")}</h2>
                <p className="onb-step__lead">{t("onboarding.v3.assign")}</p>
              </>
            )}
            {step === "tryit" && !nagaV3 && (
              <>
                <h2 className="onb-step__title">{T.tryit.title}</h2>
                <p className="onb-step__lead">{T.tryit.lead}</p>
                {fired ? (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" />
                    {T.tryit.fired}: <strong className="onb-result__value">{fired.actionPretty}</strong>
                    {fired.resolvedProfileName ? `(${fired.resolvedProfileName})` : ""}
                  </div>
                ) : (
                  <div className="onb-result is-pending">{T.tryit.waiting}</div>
                )}
                {runtimeSetupError ? (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {runtimeSetupError}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="onb-footer">
          <button type="button" className="onb-btn ghost" onClick={goBack} disabled={stepIdx === 0}>
            {T.back}
          </button>
          <div className="onb-spacer" />
          <button type="button" className="onb-btn primary" onClick={goNext} disabled={nagaV3 && step === "live" && !v3Confirmed}>
            {stepIdx === steps.length - 1 ? T.finish : T.next}
          </button>
        </div>
    </ModalShell>
  );
}

function CheckRow({
  state,
  label,
  hint,
  action,
}: {
  state: CheckState;
  label: string;
  hint: string;
  /** Optional inline affordance shown in place of the hint (e.g. a fix button). */
  action?: ReactNode;
}) {
  const dot = state === "ok" ? "ok" : state === "bad" ? "bad" : "pending";
  return (
    <div className="onb-check">
      <span className={`onb-check__dot ${dot}`} />
      <span className="onb-check__label">{label}</span>
      {action ?? <span className="onb-check__hint">{hint}</span>}
    </div>
  );
}

function hintFor(state: CheckState, T: Copy): string {
  if (state === "ok") return T.checkOk;
  if (state === "bad") return T.checkBad;
  return T.checkPending;
}

interface Copy {
  brand: string;
  ariaTitle: string;
  ariaLanguage: string;
  ariaNaga: string;
  skip: string;
  back: string;
  next: string;
  finish: string;
  checkOk: string;
  checkBad: string;
  checkPending: string;
  welcome: {
    title: string;
    lead: string;
    checks: string;
    cSynapse: string;
    cElevated: string;
    cNaga: string;
    nagaHint: string;
    relaunch: string;
    synapseHint: string;
  };
  mouse: {
    title: string;
    lead: string;
    s1: string;
    s2: string;
    write: string;
    written: string;
  };
  live: { title: string; lead: string; waiting: string; last: string; allDone: string };
  admin: { title: string; lead: string; enable: string; busy: string; already: string; autostartConfigured: string; relaunch: string; note: string };
  tryit: { title: string; lead: string; waiting: string; fired: string };
}
