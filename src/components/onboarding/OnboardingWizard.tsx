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
  saveBundledSynapseProfile,
  setAdminAutostart,
  setInputCaptureMode,
  startRuntime,
} from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import type { ActionExecutionEvent, EncodedKeyEvent } from "../../lib/runtime";
import { NagaIllustration } from "./NagaIllustration";
import { ModalShell } from "../shared";
import "./onboarding.css";

type StepKey = "welcome" | "synapse" | "live" | "admin" | "tryit";
const STEPS: StepKey[] = ["welcome", "synapse", "live", "admin", "tryit"];

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

  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx];

  // Pre-flight
  const [synapseOk, setSynapseOk] = useState<CheckState>("pending");
  const [elevated, setElevated] = useState<CheckState>("pending");

  // Live test
  const [detected, setDetected] = useState<Set<number>>(new Set());
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [activeBtn, setActiveBtn] = useState<number | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const activeTimer = useRef<number | null>(null);

  // Synapse-profile save (for the "Save profile" button on the Synapse step)
  const [synapseSavedPath, setSynapseSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    void checkSynapseInstalled()
      .then((ok) => !cancelled && setSynapseOk(ok ? "ok" : "bad"))
      .catch(() => !cancelled && setSynapseOk("bad"));
    void isRunningAsAdmin()
      .then((ok) => !cancelled && setElevated(ok ? "ok" : "bad"))
      .catch(() => !cancelled && setElevated("bad"));
    void getAdminAutostartStatus()
      .then((s) => !cancelled && setAdmin(s))
      .catch((err) => !cancelled && setAdminError(normalizeCommandError(err).message));

    void listenEncodedKeyEvent("encoded_key_received", (e: EncodedKeyEvent) => {
      if (e.isKeyUp) return;
      const btn = fkeyToButton(e.encodedKey);
      if (btn === null) return;
      setActiveBtn(btn);
      setLastKey(e.encodedKey);
      setDetected((prev) => {
        if (prev.has(btn)) return prev;
        const next = new Set(prev);
        next.add(btn);
        return next;
      });
      setLabels((prev) => (prev[btn] ? prev : { ...prev, [btn]: e.encodedKey }));
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
    void setInputCaptureMode(inLive);
    return () => {
      if (inLive) void setInputCaptureMode(false);
    };
  }, [step]);

  const complete = useCallback(() => {
    applyConfig({ ...config, settings: { ...config.settings, onboardingCompleted: true } });
    onClose();
  }, [config, applyConfig, onClose]);

  // Keyboard containment + Escape-to-skip handled by ModalShell. Auto-focus the
  // first button on mount.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  const goNext = useCallback(() => {
    // Keep the setState updater pure: decide from the current index in the
    // closure and run the side effect (complete()) outside it, so StrictMode's
    // double-invoked updater can't fire complete() twice.
    if (stepIdx >= STEPS.length - 1) {
      complete();
    } else {
      setStepIdx((i) => i + 1);
    }
  }, [stepIdx, complete]);
  const goBack = useCallback(() => setStepIdx((i) => Math.max(0, i - 1)), []);

  const saveSynapse = useCallback(async (reveal: boolean): Promise<string | null> => {
    setSaveError(null);
    try {
      const path = await saveBundledSynapseProfile(reveal);
      setSynapseSavedPath(path);
      return path;
    } catch (err) {
      setSaveError(normalizeCommandError(err).message);
      return null;
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

        <div className="onb-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={stepIdx + 1}>
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-label={`${i + 1}/${STEPS.length}`}
              className={`onb-dot ${i === stepIdx ? "is-current" : i < stepIdx ? "is-done" : ""}`}
              onClick={() => i < stepIdx && setStepIdx(i)}
            />
          ))}
        </div>

        <div className="onb-body">
          <div className="onb-step" key={step}>
            {step === "welcome" && (
              <>
                <h2 className="onb-step__title">{T.welcome.title}</h2>
                <p className="onb-step__lead">{T.welcome.lead}</p>
                <div className="onb-step__section-title">{T.welcome.checks}</div>
                <div className="onb-checks">
                  <CheckRow state={synapseOk} label={T.welcome.cSynapse} hint={hintFor(synapseOk, T)} />
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

            {step === "synapse" && (
              <>
                <h2 className="onb-step__title">{T.synapse.title}</h2>
                <p className="onb-step__lead">{T.synapse.lead}</p>
                <ol className="onb-steps-list">
                  <li>{T.synapse.s1}</li>
                  <li>{T.synapse.s2}</li>
                  <li>{T.synapse.s3}</li>
                  <li>{T.synapse.s4}</li>
                </ol>
                <div className="onb-actions">
                  <button type="button" className="onb-btn primary" onClick={() => void saveSynapse(true)}>
                    {T.synapse.save}
                  </button>
                </div>
                {synapseSavedPath && (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" />
                    {T.synapse.saved}: <code className="onb-result__path">{synapseSavedPath}</code>
                  </div>
                )}
                {saveError && (
                  <div className="onb-result">
                    <span className="onb-check__dot bad" /> {saveError}
                  </div>
                )}
              </>
            )}

            {step === "live" && (
              <>
                <h2 className="onb-step__title">{T.live.title}</h2>
                <p className="onb-step__lead">{T.live.lead}</p>
                <NagaIllustration detected={detected} active={activeBtn} labels={labels} label={T.ariaNaga} />
                <div className="onb-live-readout">
                  {lastKey ? (
                    <>
                      {T.live.last} <strong>{lastKey}</strong> — {detectedCount}/12
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

            {step === "tryit" && (
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
          <button type="button" className="onb-btn primary" onClick={goNext}>
            {stepIdx === STEPS.length - 1 ? T.finish : T.next}
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
  };
  synapse: {
    title: string;
    lead: string;
    s1: string;
    s2: string;
    s3: string;
    s4: string;
    save: string;
    saved: string;
  };
  live: { title: string; lead: string; waiting: string; last: string; allDone: string };
  admin: { title: string; lead: string; enable: string; busy: string; already: string; autostartConfigured: string; relaunch: string; note: string };
  tryit: { title: string; lead: string; waiting: string; fired: string };
}
