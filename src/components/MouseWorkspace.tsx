import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OFFLINE_PROFILE_ACTIVE, type AppConfig, type Profile } from "../lib/config";
import { upsertProfile } from "../lib/config-editing";
import {
  getDeviceReport,
  getMouseSettings,
  getNativeModel,
  listenMouseBattery,
  normalizeCommandError,
  openDeviceReportIssue,
  setKeySignals,
  setMouseDpi,
  setMousePollRate,
} from "../lib/backend";
import type { MouseSettings as MouseSettingsState, MouseStatusKind, NativeModelInfo } from "../lib/onboard-mapping";
import { PillTrack } from "./PillTrack";
import { DpiStagesEditor } from "./DpiStagesEditor";
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
  const { t } = useTranslation();
  const [device, setDevice] = useState<MouseSettingsState | null>(null);
  const [model, setModel] = useState<NativeModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dpiDraft, setDpiDraft] = useState("");
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  /** The signal kind being switched to, until the switch is done; then "done". */
  const [signalsSwitch, setSignalsSwitch] = useState<boolean | "done" | null>(null);

  async function run(request: () => Promise<MouseSettingsState>) {
    setBusy(true);
    try {
      setDevice(await request());
      setError(null);
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    getNativeModel().then(setModel, (unknownError: unknown) =>
      setError(normalizeCommandError(unknownError).message),
    );
    void run(getMouseSettings);
    let unlisten: (() => void) | undefined;
    void listenMouseBattery(({ percent }) => {
      setDevice((current) => (current ? { ...current, batteryPercent: percent } : current));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | undefined;
    void listenActionExecutionEvent("action_executed", (event) => {
      if (event.actionType === "mouseAction" && event.summary.startsWith("DPI switched to ")) {
        void getMouseSettings().then((settings) => { if (alive) setDevice(settings); }, () => {});
      }
    }).then((fn) => { if (alive) dispose = fn; else fn(); });
    return () => { alive = false; dispose?.(); };
  }, []);

  const profileDpi = activeProfile?.mouseDpi;
  const profilePoll = activeProfile?.mousePollRateHz;
  const overrides = profileDpi !== undefined || profilePoll !== undefined || (activeProfile?.mouseDpiStages?.length ?? 0) > 0;
  const appliesNow = activeProfile !== null && activeProfile.id === runtimeProfileId;

  useEffect(() => {
    setDpiDraft(profileDpi !== undefined ? String(profileDpi) : "");
  }, [profileDpi, activeProfile?.id]);

  function saveProfile(patch: Partial<Pick<Profile, "mouseDpi" | "mousePollRateHz" | "mouseDpiStages">>) {
    if (!activeProfile) return;
    updateDraft((config) => upsertProfile(config, { ...activeProfile, ...patch }));
  }

  /** Writes a value to the mouse when the edited profile is the one in effect. */
  function applyNow(request: () => Promise<MouseSettingsState>) {
    if (appliesNow) void run(request);
  }

  /** Reads the mouse (no writes), copies the dump and opens a new issue for it. */
  async function sendDeviceReport() {
    setReporting(true);
    try {
      const text = await getDeviceReport();
      setReport(text);
      setError(null);
      // The textarea below keeps the report reachable if the copy is refused.
      setReportCopied(await navigator.clipboard.writeText(text).then(() => true, () => false));
      await openDeviceReportIssue();
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError).message);
    } finally {
      setReporting(false);
    }
  }

  /** Switches what the key buttons send (a running capture restarts to follow). */
  async function switchSignals(consumer: boolean) {
    setSignalsSwitch(consumer);
    try {
      await setKeySignals(consumer);
      setModel(await getNativeModel());
      setError(null);
      setSignalsSwitch("done");
    } catch (unknownError) {
      setError(normalizeCommandError(unknownError).message);
      setSignalsSwitch(null);
    }
  }

  const dpiValue = Number(dpiDraft);
  const dpiValid =
    model !== null &&
    Number.isInteger(dpiValue) &&
    dpiValue >= model.dpiMin &&
    dpiValue <= model.dpiMax;

  return (
    <div className="settings-shell__content">
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
              disabled={reporting}
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
                disabled={!overrides && device === null}
                onChange={(checked) =>
                  saveProfile(
                    checked
                      ? { mouseDpi: device?.dpi, mousePollRateHz: device?.pollRateHz }
                      : { mouseDpi: undefined, mousePollRateHz: undefined, mouseDpiStages: undefined },
                  )
                }
                ariaLabel={t("mouse.profileOverride")}
              />
            </div>
          </div>
          <p className="panel__muted help-sm">
            {overrides ? t("mouse.profileHelpOn") : t("mouse.profileHelpOff")}
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
                  onSelect={(key) => {
                    const hz = Number(key);
                    saveProfile({ mouseDpi: profileDpi, mousePollRateHz: hz });
                    applyNow(() => setMousePollRate(hz));
                  }}
                />
              </SettingRow>
              <SettingRow
                title={t("mouse.dpi")}
                hint={model ? t("mouse.dpiCaption", { min: model.dpiMin, max: model.dpiMax }) : undefined}
              >
                <div className="input-suffix input-suffix--compact">
                  <input
                    type="number"
                    min={model?.dpiMin}
                    max={model?.dpiMax}
                    step={50}
                    value={dpiDraft}
                    aria-label={t("mouse.dpi")}
                    onChange={(e) => setDpiDraft(e.target.value)}
                    disabled={busy || (activeProfile.mouseDpiStages?.length ?? 0) > 0}
                  />
                  <span className="input-suffix__unit">{t("mouse.dpiUnit")}</span>
                </div>
                <button
                  type="button"
                  className="action-button action-button--secondary action-button--small"
                  onClick={() => {
                    saveProfile({ mouseDpi: dpiValue, mousePollRateHz: profilePoll });
                    applyNow(() => setMouseDpi(dpiValue));
                  }}
                  disabled={busy || !dpiValid || dpiValue === profileDpi || (activeProfile.mouseDpiStages?.length ?? 0) > 0}
                >
                  {t("mouse.apply")}
                </button>
              </SettingRow>
              {model ? <DpiStagesEditor
                key={activeProfile.id}
                stages={activeProfile.mouseDpiStages ?? []}
                startingDpi={profileDpi}
                currentDpi={appliesNow ? device?.dpi : undefined}
                dpiMin={model.dpiMin} dpiMax={model.dpiMax} busy={busy}
                onSave={(stages, dpi) => {
                  saveProfile({ mouseDpiStages: stages, mouseDpi: dpi });
                  if (dpi !== undefined && dpi !== profileDpi) applyNow(() => setMouseDpi(dpi));
                }} /> : null}
            </>
          ) : null}
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
        <SettingRow title={t("mouse.batteryHeader")} hint={t("mouse.batteryHelp")}>
          {device ? (
            <strong>{t("mouse.batteryValue", { percent: device.batteryPercent })}</strong>
          ) : null}
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
        {error ? (
          <Notice variant="warning" className="mt-12">
            <p>{t("mouse.unavailable")}</p>
            <p className="panel__muted help-caption">{error}</p>
            <button
              type="button"
              className="action-button action-button--secondary action-button--small mt-8"
              onClick={() => void run(getMouseSettings)}
              disabled={busy}
            >
              {t("mouse.retry")}
            </button>
          </Notice>
        ) : null}
      </section>
    </div>
  );
}
