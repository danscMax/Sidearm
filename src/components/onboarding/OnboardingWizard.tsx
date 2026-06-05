import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  saveBundledSynapseProfile,
  setAdminAutostart,
  setInputCaptureMode,
  startRuntime,
} from "../../lib/backend";
import type { AppConfig } from "../../lib/config";
import type { ActionExecutionEvent, EncodedKeyEvent } from "../../lib/runtime";
import { NagaIllustration } from "./NagaIllustration";
import { useModalDismiss } from "../../hooks/useModalDismiss";
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
  const { i18n } = useTranslation();
  const lang: Lang = i18n.language?.startsWith("en") ? "en" : "ru";
  const T = COPY[lang];

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

  // Finale
  const [fired, setFired] = useState<ActionExecutionEvent | null>(null);

  // --- one-time setup: start runtime, run checks, subscribe to live events ---
  useEffect(() => {
    let unlistenKey: (() => void) | null = null;
    let unlistenAction: (() => void) | null = null;
    let cancelled = false;

    void startRuntime().catch(() => {});
    void checkSynapseInstalled()
      .then((ok) => !cancelled && setSynapseOk(ok ? "ok" : "bad"))
      .catch(() => !cancelled && setSynapseOk("bad"));
    void isRunningAsAdmin()
      .then((ok) => !cancelled && setElevated(ok ? "ok" : "bad"))
      .catch(() => !cancelled && setElevated("bad"));
    void getAdminAutostartStatus()
      .then((s) => !cancelled && setAdmin(s))
      .catch(() => {});

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
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenKey = fn;
    });

    void listenActionExecutionEvent("action_executed", (e: ActionExecutionEvent) => {
      setFired(e);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenAction = fn;
    });

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

  // Keyboard containment + Escape-to-skip, matching the app's other modals.
  const overlayRef = useRef<HTMLDivElement>(null);
  const handleModalKeyDown = useModalDismiss(overlayRef, { onClose: complete });
  useEffect(() => {
    overlayRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  const goNext = useCallback(() => {
    setStepIdx((i) => {
      if (i >= STEPS.length - 1) {
        complete();
        return i;
      }
      return i + 1;
    });
  }, [complete]);
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
    try {
      const next = await setAdminAutostart(true);
      setAdmin(next);
      if (next.enabled) setElevated("ok");
    } catch {
      // UAC declined / failed — leave state as-is.
    } finally {
      setAdminBusy(false);
    }
  }, []);

  const detectedCount = detected.size;

  const readiness = useMemo<CheckState>(() => {
    if (synapseOk === "pending" || elevated === "pending") return "pending";
    return synapseOk === "ok" ? "ok" : "bad";
  }, [synapseOk, elevated]);

  return (
    <div
      className="onb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={T.ariaTitle}
      ref={overlayRef}
      onKeyDown={handleModalKeyDown}
    >
      <div className="onb-card">
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
                  <CheckRow state={elevated} label={T.welcome.cElevated} hint={hintFor(elevated, T)} />
                  <CheckRow state={readiness} label={T.welcome.cNaga} hint={T.welcome.nagaHint} />
                </div>
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
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button type="button" className="onb-btn primary" onClick={() => void saveSynapse(true)}>
                    {T.synapse.save}
                  </button>
                </div>
                {synapseSavedPath && (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" />
                    {T.synapse.saved}: <code style={{ marginLeft: 6 }}>{synapseSavedPath}</code>
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
              </>
            )}

            {step === "admin" && (
              <>
                <h2 className="onb-step__title">{T.admin.title}</h2>
                <p className="onb-step__lead">{T.admin.lead}</p>
                {elevated === "ok" || admin?.enabled ? (
                  <div className="onb-result">
                    <span className="onb-check__dot ok" /> {T.admin.already}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="onb-btn primary"
                    onClick={() => void toggleAdmin()}
                    disabled={adminBusy}
                  >
                    {adminBusy ? T.admin.busy : T.admin.enable}
                  </button>
                )}
                <p className="onb-step__lead" style={{ marginTop: 14, fontSize: 12 }}>
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
                    {T.tryit.fired}: <strong style={{ margin: "0 6px" }}>{fired.actionPretty}</strong>
                    {fired.resolvedProfileName ? `(${fired.resolvedProfileName})` : ""}
                  </div>
                ) : (
                  <div className="onb-result is-pending">{T.tryit.waiting}</div>
                )}
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
      </div>
    </div>
  );
}

function CheckRow({ state, label, hint }: { state: CheckState; label: string; hint: string }) {
  const dot = state === "ok" ? "ok" : state === "bad" ? "bad" : "pending";
  return (
    <div className="onb-check">
      <span className={`onb-check__dot ${dot}`} />
      <span className="onb-check__label">{label}</span>
      <span className="onb-check__hint">{hint}</span>
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
  admin: { title: string; lead: string; enable: string; busy: string; already: string; note: string };
  tryit: { title: string; lead: string; waiting: string; fired: string };
}

const COPY: Record<Lang, Copy> = {
  ru: {
    brand: "Настройка Sidearm",
    ariaTitle: "Настройка Sidearm",
    ariaLanguage: "Язык",
    ariaNaga: "Сетка кнопок Razer Naga",
    skip: "Пропустить настройку",
    back: "Назад",
    next: "Далее",
    finish: "Готово",
    checkOk: "готово",
    checkBad: "не найдено",
    checkPending: "проверка…",
    welcome: {
      title: "Добро пожаловать в Sidearm",
      lead: "Sidearm превращает кнопки Razer Naga в удобные действия для каждого приложения. Пройдём настройку за пару минут: подготовим Razer Synapse, проверим железо вживую и зальём готовый профиль.",
      checks: "Проверка окружения",
      cSynapse: "Razer Synapse установлен",
      cElevated: "Sidearm запущен от администратора",
      cNaga: "Готовность",
      nagaHint: "проверим на шаге «Тест»",
    },
    synapse: {
      title: "Настройка Razer Synapse",
      lead: "Чтобы Sidearm видел кнопки мыши, Naga должна слать F13–F24. Мы подготовили готовый профиль Synapse — сохраните его и импортируйте в Razer Synapse.",
      s1: "Нажмите «Сохранить профиль» — файл ляжет в Загрузки и откроется папка.",
      s2: "Откройте Razer Synapse → раздел «Профили».",
      s3: "Импортируйте сохранённый файл Sidearm_profile.synapse4 и сделайте его активным.",
      s4: "Готово — Naga теперь шлёт F13–F24. Проверим это на следующем шаге.",
      save: "Сохранить профиль",
      saved: "Сохранено",
    },
    live: {
      title: "Живой тест железа",
      lead: "Нажимайте кнопки на боковой панели Naga — они должны загораться здесь. Так мы убедимся, что Synapse реально шлёт F-клавиши.",
      waiting: "Ждём нажатий… нажмите любую кнопку Naga.",
      last: "Поймана клавиша",
      allDone: "Отлично — все 12 кнопок отвечают!",
    },
    admin: {
      title: "Работа в окнах с правами администратора",
      lead: "В окнах вроде Диспетчера задач Windows блокирует ввод от обычных программ (UIPI). Чтобы Naga работала и там, запускайте Sidearm от администратора.",
      enable: "Включить автозапуск от администратора",
      busy: "Включение… (подтвердите UAC)",
      already: "Sidearm уже работает с правами администратора.",
      note: "Создаётся задача в Планировщике (запуск при входе). Это можно изменить позже в Настройках.",
    },
    tryit: {
      title: "Попробуйте!",
      lead: "Переключитесь в любое приложение и нажмите кнопку Naga. Как только действие сработает — увидите его здесь.",
      waiting: "Ждём первое действие…",
      fired: "Сработало",
    },
  },
  en: {
    brand: "Sidearm setup",
    ariaTitle: "Sidearm onboarding",
    ariaLanguage: "Language",
    ariaNaga: "Razer Naga thumb grid",
    skip: "Skip setup",
    back: "Back",
    next: "Next",
    finish: "Done",
    checkOk: "ready",
    checkBad: "not found",
    checkPending: "checking…",
    welcome: {
      title: "Welcome to Sidearm",
      lead: "Sidearm turns your Razer Naga buttons into per-app actions. Setup takes a couple of minutes: prepare Razer Synapse, verify the hardware live, and load a ready-made profile.",
      checks: "Environment check",
      cSynapse: "Razer Synapse installed",
      cElevated: "Sidearm running as administrator",
      cNaga: "Readiness",
      nagaHint: "verified in the Test step",
    },
    synapse: {
      title: "Set up Razer Synapse",
      lead: "For Sidearm to see your mouse buttons, the Naga must emit F13–F24. We ship a ready Synapse profile — save it and import it into Razer Synapse.",
      s1: "Click “Save profile” — the file lands in Downloads and the folder opens.",
      s2: "Open Razer Synapse → Profiles.",
      s3: "Import the saved Sidearm_profile.synapse4 and make it active.",
      s4: "Done — the Naga now emits F13–F24. We'll verify that next.",
      save: "Save profile",
      saved: "Saved",
    },
    live: {
      title: "Live hardware test",
      lead: "Press the buttons on the Naga side panel — they should light up here. This confirms Synapse is really emitting the F-keys.",
      waiting: "Waiting for presses… press any Naga button.",
      last: "Captured key",
      allDone: "Nice — all 12 buttons respond!",
    },
    admin: {
      title: "Working in administrator windows",
      lead: "In windows like Task Manager, Windows blocks input from normal programs (UIPI). To make the Naga work there too, run Sidearm as administrator.",
      enable: "Enable run-as-admin autostart",
      busy: "Enabling… (confirm UAC)",
      already: "Sidearm is already running as administrator.",
      note: "Creates a Task Scheduler entry (launch at logon). You can change this later in Settings.",
    },
    tryit: {
      title: "Try it!",
      lead: "Switch to any app and press a Naga button. As soon as an action fires, you'll see it here.",
      waiting: "Waiting for the first action…",
      fired: "Fired",
    },
  },
};
