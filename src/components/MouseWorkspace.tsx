import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OFFLINE_PROFILE_ACTIVE, RAZER_NAGA_DEVICE_ID, type AppConfig, type MouseOverrides, type Profile } from "../lib/config";
import { uiText } from "../lib/ui-text";
import { setProfileDeviceSlot, setProfileMouse } from "../lib/config-editing";
import {
  getDeviceReport,
  getMouseSettings,
  getNativeModel,
  getOnboardBanks,
  listenMouseBattery,
  listenNativeMiceChanged,
  listNativeMice,
  normalizeCommandError,
  openDeviceReportIssue,
  setKeySignals,
  setMouseDpi,
  setMousePollRate,
} from "../lib/backend";
import type { MouseSettings as MouseSettingsState, MouseStatusKind, NativeModelInfo, OnboardBanks } from "../lib/onboard-mapping";
import { PillTrack } from "./PillTrack";
import { dpiStageChoices, dpiStagesForValue } from "../lib/dpi-stages";
import { listenActionExecutionEvent } from "../lib/backend";
import { Notice, SelectField, SettingRow, Toggle } from "./shared";

export interface MouseWorkspaceProps {
  activeConfig: AppConfig;
  /** Profiles in the sidebar's order. */
  profiles: Profile[];
  /** The profile being edited — the same selection as the sidebar. */
  activeProfile: Profile | null;
  /** The profile the runtime applies now: its edits reach the mouse at once. */
  runtimeProfileId: string | null;
  setSelectedProfileId: (id: string | null) => void;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  /** Active mouse-path states (`mouse_status`), shown as warnings on top. */
  mouseStates: MouseStatusKind[];
}

const STATE_MESSAGE: Partial<Record<MouseStatusKind, string>> = {
  helperLost: "mouse.statusHelperLost",
  buttonsUnreadable: "mouse.statusButtonsUnreadable",
  mouseUnreachable: "mouse.statusMouseUnreachable",
};

/** The "Mouse" workspace: a profile switcher on top, the selected profile's own
 *  DPI / poll rate (written into the mouse on every switch to that profile), and
 *  the battery with the tray-badge switch. */
export function MouseWorkspace({
  activeConfig,
  profiles,
  activeProfile,
  runtimeProfileId,
  setSelectedProfileId,
  updateDraft,
  mouseStates,
}: MouseWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const [device, setDevice] = useState<MouseSettingsState | null>(null);
  const [model, setModel] = useState<NativeModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dpiDraft, setDpiDraft] = useState("");
  const [manualDpi, setManualDpi] = useState(false);
  const dpiInput = useRef<HTMLInputElement>(null);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  /** The signal kind being switched to, until the switch is done; then "done". */
  const [signalsSwitch, setSignalsSwitch] = useState<boolean | "done" | null>(null);

  const [readAt, setReadAt] = useState<number | null>(null);
  const [writeConfirmed, setWriteConfirmed] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState<boolean | null>(null);
  const lifecycle = useRef<{
    alive: boolean; version: number; pending: boolean; queued: boolean;
    /** A write that arrived while another request ran: it runs next, never dropped. */
    queuedWrite: ((deviceId?: string) => Promise<MouseSettingsState>) | null;
  }>({ alive: false, version: 0, pending: false, queued: false, queuedWrite: null });
  const reportPending = useRef(false);
  // Several connected mice: the one this page reads and writes.
  const [mice, setMice] = useState<NativeModelInfo[]>([]);
  const [chosenMouse, setChosenMouse] = useState<string | null>(null);
  const target = (mice.find((mouse) => mouse.deviceId === chosenMouse) ?? mice[0])?.deviceId;
  const targetRef = useRef(target);
  const [banks, setBanks] = useState<OnboardBanks | null>(null);

  async function run(request: (deviceId?: string) => Promise<MouseSettingsState>, writing = false) {
    const state = lifecycle.current;
    if (!state.alive) return;
    if (state.pending) {
      if (writing) {
        state.queuedWrite = request;
        state.version += 1; // the running request's result is older than this write
      }
      return;
    }
    state.pending = true;
    const version = ++state.version;
    setBusy(true);
    try {
      const deviceId = targetRef.current;
      const [readings, descriptor] = await Promise.allSettled([request(deviceId), getNativeModel(deviceId)]);
      if (!state.alive || state.version !== version) return;
      if (descriptor.status === "fulfilled") setModel(descriptor.value);
      if (readings.status === "fulfilled") {
        setDevice(readings.value);
        setReadAt(Date.now());
        setWriteConfirmed(writing);
        setError(descriptor.status === "rejected" ? normalizeCommandError(descriptor.reason).message : null);
      } else {
        // A failed refresh must not leave old numbers looking like fresh readings.
        setDevice(null);
        setReadAt(null);
        setWriteConfirmed(false);
        setError(normalizeCommandError(readings.reason).message);
      }
    } finally {
      state.pending = false;
      if (state.alive) {
        setBusy(false);
        const write = state.queuedWrite;
        state.queuedWrite = null;
        if (write) { state.queued = false; void run(write, true); }
        else if (state.queued) { state.queued = false; refresh(); }
      }
    }
  }

  function refresh() {
    const state = lifecycle.current;
    if (!state.alive) return;
    if (state.pending) {
      // New device events invalidate the older request; coalesce into one refresh.
      state.version += 1;
      state.queued = true;
    } else {
      void run(getMouseSettings);
    }
  }

  useEffect(() => {
    const state = lifecycle.current;
    state.alive = true;
    // The first read comes from the effect on the shown mouse below.
    let subscribed = true;
    const disposers: (() => void)[] = [];
    void listNativeMice().then((list) => { if (subscribed) setMice(list); }, () => {});
    const subscriptions = [
      listenNativeMiceChanged((list) => { if (subscribed) setMice(list); }),
      listenMouseBattery(() => { if (subscribed) refresh(); }),
      listenActionExecutionEvent("action_executed", (event) => {
        if (subscribed && event.actionType === "mouseAction" && typeof event.summary === "object" && event.summary.key === "execution.dpiSwitched") refresh();
      }),
    ];
    for (const subscription of subscriptions) {
      void subscription.then((dispose) => { if (subscribed) disposers.push(dispose); else dispose(); },
        (unknownError: unknown) => { if (subscribed) setError(normalizeCommandError(unknownError).message); });
    }
    return () => { subscribed = false; state.alive = false; state.version += 1; disposers.forEach((dispose) => dispose()); };
  }, []);

  // A new mouse to show: read it (the ref serves callbacks bound at mount).
  useEffect(() => {
    targetRef.current = target;
    setSummary(null);
    setSummaryCopied(null);
    setReport(null);
    setReportCopied(false);
    setSignalsSwitch(null);
    refresh();
  }, [target]);

  useEffect(() => {
    setBanks(null);
    if (!model?.banks || !model.connected) return;
    let current = true;
    void getOnboardBanks(model.deviceId).then((next) => { if (current) setBanks(next); }, () => {});
    return () => { current = false; };
  }, [model?.deviceId, model?.banks, model?.connected]);

  // The profile's own settings for the mouse shown.
  const mouseId = target ?? model?.deviceId ?? RAZER_NAGA_DEVICE_ID;
  const own = activeProfile?.deviceMouse?.[mouseId];
  const profileDpi = own?.mouseDpi;
  const profilePoll = own?.mousePollRateHz;
  const overrides = profileDpi !== undefined || profilePoll !== undefined || (own?.mouseDpiStages?.length ?? 0) > 0;
  const appliesNow = activeProfile !== null && activeProfile.id === runtimeProfileId;

  useEffect(() => {
    setDpiDraft(profileDpi !== undefined ? String(profileDpi) : "");
  }, [profileDpi, activeProfile?.id, mouseId]);

  useEffect(() => { setManualDpi(false); }, [activeProfile?.id, mouseId]);

  function saveProfile(patch: Partial<MouseOverrides>) {
    if (!activeProfile) return;
    updateDraft((config) => setProfileMouse(config, activeProfile.id, mouseId, patch));
  }

  /** Writes a value to the mouse when the edited profile is the one in effect. */
  function applyNow(request: (deviceId?: string) => Promise<MouseSettingsState>) {
    if (appliesNow) void run(request, true);
  }

  /** Reads the mouse (no writes), copies the dump and opens a new issue for it. */
  async function sendDeviceReport() {
    if (reportPending.current || lifecycle.current.pending) return;
    reportPending.current = true;
    setReporting(true);
    try {
      const text = await getDeviceReport(undefined, target);
      if (!lifecycle.current.alive) return;
      setReport(text);
      setError(null);
      // The textarea below keeps the report reachable if the copy is refused.
      const copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
      if (!lifecycle.current.alive) return;
      setReportCopied(copied);
      await openDeviceReportIssue();
    } catch (unknownError) {
      if (lifecycle.current.alive) setError(normalizeCommandError(unknownError).message);
    } finally {
      reportPending.current = false;
      if (lifecycle.current.alive) setReporting(false);
    }
  }

  async function readSummary() {
    if (reportPending.current || lifecycle.current.pending) return;
    reportPending.current = true;
    setReporting(true);
    setSummaryCopied(null);
    try {
      const text = await getDeviceReport("summary", target);
      if (lifecycle.current.alive) { setSummary(text); setError(null); }
    } catch (unknownError) {
      if (lifecycle.current.alive) setError(normalizeCommandError(unknownError).message);
    } finally {
      reportPending.current = false;
      if (lifecycle.current.alive) setReporting(false);
    }
  }

  async function copySummary() {
    if (summary === null) return;
    const copied = await navigator.clipboard.writeText(summary).then(() => true, () => false);
    if (lifecycle.current.alive) setSummaryCopied(copied);
  }

  /** Switches what the key buttons send (a running capture restarts to follow). */
  async function switchSignals(consumer: boolean) {
    setSignalsSwitch(consumer);
    try {
      await setKeySignals(consumer);
      const descriptor = await getNativeModel(target);
      if (!lifecycle.current.alive) return;
      setModel(descriptor);
      setError(null);
      setSignalsSwitch("done");
    } catch (unknownError) {
      if (lifecycle.current.alive) {
        setError(normalizeCommandError(unknownError).message);
        setSignalsSwitch(null);
      }
    }
  }

  const seedAvailable = device != null && (device.dpi !== null || device.pollRateHz !== null);
  const snapshotStatus = device?.status ?? "unavailable";
  const hardwareBusy = busy || reporting || typeof signalsSwitch === "boolean";
  const dpiValue = Number(dpiDraft);
  const dpiValid =
    model !== null &&
    Number.isInteger(dpiValue) &&
    dpiValue >= model.dpiMin &&
    dpiValue <= model.dpiMax;

  const dpiChoices = model ? dpiStageChoices(own?.mouseDpiStages, profileDpi, model.dpiMin, model.dpiMax) : [];
  function applyDpi(value: number) {
    if (!model || hardwareBusy) return;
    const stages = dpiStagesForValue(dpiChoices, profileDpi, value, model.dpiMin, model.dpiMax);
    if (!stages) return;
    setDpiDraft(String(value));
    saveProfile({ mouseDpi: value, mouseDpiStages: stages });
    if (device?.dpi !== value) applyNow((deviceId) => setMouseDpi(value, deviceId));
  }

  return (
    <div className="settings-shell__content">
      {mice.length > 1 ? (
        <section className="settings-section">
          <SettingRow title={t("mouse.devicePicker")} hint={t("mouse.devicePickerHelp")}>
            <PillTrack
              items={mice.map((mouse) => ({ key: mouse.deviceId, label: mouse.name }))}
              active={target ?? ""}
              pillProps={() => ({ disabled: hardwareBusy })}
              onSelect={(id) => setChosenMouse(id)}
            />
          </SettingRow>
        </section>
      ) : null}
      {mouseStates.flatMap((kind) => {
        const key = STATE_MESSAGE[kind];
        return key ? [<Notice key={kind} variant="warning"><p>{t(key)}</p></Notice>] : [];
      })}
      {model && !model.verified ? (
        <Notice variant="warning">
          <p>{t("mouse.unverifiedModel", { name: model.name })}</p>
          {model.connected ? (
            <button
              type="button"
              className="action-button action-button--secondary action-button--small mt-8"
              disabled={hardwareBusy}
              onClick={() => void sendDeviceReport()}
            >
              {reporting ? t("mouse.reportReading") : t("mouse.reportButton")}
            </button>
          ) : (
            <p className="notice__hint">{t("mouse.reportConnect")}</p>
          )}
          {report !== null ? (
            <>
              <p className="notice__hint">{t(reportCopied ? "mouse.reportCopied" : "mouse.reportCopyFailed")}</p>
              <textarea className="input input--multiline mouse-report" readOnly rows={6} value={report} aria-label={t("mouse.reportButton")} />
            </>
          ) : null}
        </Notice>
      ) : null}
      <section className="settings-section" aria-label={t("mouse.liveHeader")}>
        <SettingRow title={t("mouse.liveHeader")} hint={t("mouse.liveHelp")}>
          <button type="button" className="action-button action-button--secondary action-button--small"
            disabled={hardwareBusy} onClick={refresh}>{t(busy ? "mouse.reading" : "mouse.retry")}</button>
          <button type="button" className="action-button action-button--secondary action-button--small"
            disabled={hardwareBusy} onClick={() => void readSummary()}>{t(reporting ? "mouse.reading" : "mouse.summaryButton")}</button>
        </SettingRow>
        <p className="panel__muted help-sm" role="status">{t(`mouse.readStatus.${snapshotStatus}`)}{readAt !== null
          ? ` · ${t("mouse.readAt", { time: new Date(readAt).toLocaleTimeString(i18n.resolvedLanguage) })}` : ""}</p>
        <SettingRow title={t("mouse.liveDpi")}><strong>{device?.dpi != null ? t("mouse.liveDpiValue", { dpi: device.dpi }) : t("mouse.noReading")}</strong></SettingRow>
        <SettingRow title={t("mouse.pollRate")}><strong>{device?.pollRateHz != null ? t("mouse.pollRateOption", { hz: device.pollRateHz }) : t("mouse.noReading")}</strong></SettingRow>
        <SettingRow title={t("mouse.batteryHeader")} hint={t("mouse.batteryHelp")}><strong>{device?.batteryPercent != null
          ? t("mouse.batteryValue", { percent: device.batteryPercent }) : t("mouse.noReading")}</strong></SettingRow>
        {error || (device?.warnings.length ?? 0) > 0 ? (
          <Notice variant="warning" className="mt-12">
            <p>{error ?? t(writeConfirmed ? "mouse.writeConfirmedPartial" : `mouse.readStatus.${snapshotStatus}`)}</p>
            {device?.warnings.length ? <details><summary>{t("mouse.readDetails")}</summary><ul>{device.warnings.map((warning) =>
              <li key={warning.field}>{uiText(warning.message)} <span className="panel__muted help-caption">{warning.details}</span></li>)}</ul></details> : null}
          </Notice>
        ) : null}
        {summary !== null ? <>
          <textarea className="input input--multiline mouse-report" readOnly rows={7} value={summary} aria-label={t("mouse.summaryButton")} />
          <button type="button" className="action-button action-button--secondary action-button--small mt-8" onClick={() => void copySummary()}>{t("mouse.copySummary")}</button>
          {summaryCopied !== null ? <p className="panel__muted help-sm" role="status">{t(summaryCopied ? "mouse.summaryCopied" : "mouse.summaryCopyFailed")}</p> : null}
        </> : null}
      </section>
      <section className="settings-section">
        <SettingRow title={t("mouse.profilePicker")} hint={t("mouse.profilePickerHelp")}>
          <PillTrack
            items={profiles.map((profile) => ({
              key: profile.id,
              label:
                profile.id === runtimeProfileId
                  ? t("mouse.profileActiveNow", { name: profile.name })
                  : profile.name,
            }))}
            active={activeProfile?.id ?? ""}
            onSelect={(id) => setSelectedProfileId(id)}
          />
        </SettingRow>
      </section>

      {activeProfile ? (
        <section className="settings-section">
          <div className="settings-section__header">
            <span className="settings-section__title">
              {t("mouse.profileHeader", { name: activeProfile.name })}
            </span>
            <div className="settings-section__master">
              <span className="settings-section__master-label">{t("mouse.profileOverride")}</span>
              <Toggle
                checked={overrides}
                // Seeded from the mouse's live values: without them it would
                // save made-up defaults.
                disabled={hardwareBusy || (!overrides && !seedAvailable)}
                onChange={(checked) =>
                  saveProfile(
                    checked
                      ? { mouseDpi: device?.dpi ?? undefined, mousePollRateHz: device?.pollRateHz ?? undefined }
                      : { mouseDpi: undefined, mousePollRateHz: undefined, mouseDpiStages: undefined },
                  )
                }
                ariaLabel={t("mouse.profileOverride")}
              />
            </div>
          </div>
          <p className="panel__muted help-sm">
            {overrides
              ? t("mouse.profileHelpOn")
              : !seedAvailable
                ? t("mouse.profileNeedsMouse")
                : t("mouse.profileHelpOff")}
          </p>

          {overrides ? (
            <>
              <SettingRow title={t("mouse.pollRate")} hint={t("mouse.pollRateCaption")}>
                <PillTrack
                  items={(model?.pollRates ?? []).map((hz) => ({
                    key: String(hz),
                    label: t("mouse.pollRateOption", { hz }),
                  }))}
                  active={String(profilePoll ?? "")}
                  pillProps={() => ({ disabled: hardwareBusy })}
                  onSelect={(key) => {
                    const hz = Number(key);
                    saveProfile({ mouseDpi: profileDpi, mousePollRateHz: hz });
                    applyNow((deviceId) => setMousePollRate(hz, deviceId));
                  }}
                />
              </SettingRow>
              <SettingRow
                title={t("mouse.dpi")}
                hint={model ? t("mouse.dpiCaption", { min: model.dpiMin, max: model.dpiMax }) : undefined}
              >
                <div className="mouse-dpi-control" role="group" aria-label={t("mouse.dpi")}>
                  <PillTrack
                    items={[...dpiChoices.map((dpi) => ({ key: String(dpi), label: String(dpi) })),
                      { key: "manual", label: t("mouse.dpiManual") }]}
                    active={manualDpi ? "manual" : String(profileDpi ?? "")}
                    pillProps={() => ({ disabled: hardwareBusy })}
                    onSelect={(key) => {
                      setManualDpi(key === "manual");
                      if (key === "manual") dpiInput.current?.focus();
                      else applyDpi(Number(key));
                    }}
                  />
                  <div className="mouse-dpi-control__entry">
                    <div className="input-suffix input-suffix--compact">
                      <input ref={dpiInput} className="input" type="number" min={model?.dpiMin} max={model?.dpiMax} step={50}
                        value={dpiDraft} aria-label={t("mouse.dpi")} title={t("mouse.manualDpiHint")}
                        onFocus={() => setManualDpi(true)}
                        onChange={(event) => { setManualDpi(true); setDpiDraft(event.target.value); }}
                        onKeyDown={(event) => { if (event.key === "Enter" && dpiValid) { event.preventDefault(); applyDpi(dpiValue); } }}
                        disabled={hardwareBusy} />
                      <span className="input-suffix__unit">{t("mouse.dpiUnit")}</span>
                    </div>
                    <button type="button" className="action-button action-button--secondary action-button--small"
                      onClick={() => applyDpi(dpiValue)}
                      disabled={hardwareBusy || !dpiValid || (dpiValue === profileDpi && (!appliesNow || device?.dpi === dpiValue))}>
                      {t("mouse.apply")}
                    </button>
                  </div>
                </div>
              </SettingRow>
            </>
          ) : null}
        </section>
      ) : null}

      {model?.banks && model.connected ? (
        <section className="settings-section" aria-label={t("mouse.slotsHeader")}>
          <SettingRow title={t("mouse.slotsHeader")} hint={t("mouse.slotsHelp", { model: model.name })} />
          {banks === null ? <p className="panel__muted help-sm">{t("mouse.slotNeedsMouse")}</p> : banks.assigned.map((bank) => {
            const holder = profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === bank);
            return (
              <SettingRow key={bank} sub title={t("mouse.slotRow", { n: bank })}
                hint={banks.active === bank ? t("mouse.slotSelected") : undefined}>
                <PillTrack
                  items={[{ key: "", label: t("mouse.slotKeep") },
                    ...profiles.map((profile) => ({ key: profile.id, label: profile.name }))]}
                  active={holder?.id ?? ""}
                  onSelect={(profileId) => updateDraft((config) => profileId
                    ? setProfileDeviceSlot(config, profileId, model.deviceId, bank)
                    : holder ? setProfileDeviceSlot(config, holder.id, model.deviceId, undefined) : config)}
                />
              </SettingRow>
            );
          })}
        </section>
      ) : null}

      {model?.consumerSignals != null ? (
        <section className="settings-section">
          <SettingRow
            title={t("mouse.signalsHeader")}
            hint={model.consumerSignals ? t("mouse.signalsConsumerHint") : t("mouse.signalsKeysHint")}
          >
            <div className="mouse-signals">
              <PillTrack
                items={[
                  { key: "consumer", label: t("mouse.signalsConsumer") },
                  { key: "keys", label: t("mouse.signalsKeys") },
                ]}
                // The choice shows at once; the switch takes a few seconds.
                active={(typeof signalsSwitch === "boolean" ? signalsSwitch : model.consumerSignals) ? "consumer" : "keys"}
                pillProps={() => ({ disabled: hardwareBusy })}
                onSelect={(key) => {
                  if (typeof signalsSwitch !== "boolean" && (key === "consumer") !== model.consumerSignals) {
                    void switchSignals(key === "consumer");
                  }
                }}
              />
              {signalsSwitch !== null ? (
                <p className="panel__muted help-sm" role="status">
                  {signalsSwitch === "done" ? t("mouse.signalsDone") : t("mouse.signalsSwitching")}
                </p>
              ) : null}
            </div>
          </SettingRow>
        </section>
      ) : null}

      <section className="settings-section">
        <SettingRow title={t("mouse.offlineHeader")} hint={t("mouse.offlineHelp")}>
          <SelectField
            ariaLabel={t("mouse.offlineHeader")}
            value={activeConfig.settings.offlineProfileId ?? ""}
            options={[
              {
                value: "",
                label: t("mouse.offlineFallback", {
                  name: profiles.find((p) => p.id === activeConfig.settings.fallbackProfileId)?.name ?? "",
                }),
              },
              { value: OFFLINE_PROFILE_ACTIVE, label: t("mouse.offlineActive") },
              ...profiles
                .filter((profile) => profile.id !== activeConfig.settings.fallbackProfileId)
                .map((profile) => ({ value: profile.id, label: profile.name })),
            ]}
            onChange={(id) =>
              updateDraft((config) => ({
                ...config,
                settings: { ...config.settings, offlineProfileId: id || undefined },
              }))
            }
          />
        </SettingRow>
        <SettingRow title={t("mouse.batteryInTray")} sub>
          <Toggle
            checked={activeConfig.settings.showBatteryInTray ?? false}
            onChange={(checked) =>
              updateDraft((config) => ({
                ...config,
                settings: { ...config.settings, showBatteryInTray: checked || undefined },
              }))
            }
            ariaLabel={t("mouse.batteryInTray")}
          />
        </SettingRow>
      </section>
    </div>
  );
}
