import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OFFLINE_PROFILE_ACTIVE, type AppConfig, type MouseOverrides, type Profile } from "../lib/config";
import { uiText } from "../lib/ui-text";
import { setProfileDeviceSlot, setProfileMouse } from "../lib/config-editing";
import {
  createOnboardBank,
  deleteOnboardBank,
  flushOnboardBanks,
  getDeviceReport,
  getMouseSettings,
  getNativeModel,
  getOnboardBanks,
  getSidearmBank,
  releaseSidearmBank,
  listenMouseBattery,
  listenNativeMiceChanged,
  normalizeCommandError,
  openDeviceReportIssue,
  setKeySignals,
  setMouseDpi,
  setMousePollRate,
} from "../lib/backend";
import {
  evaluateHybridBankStatus,
  summarizeProfileHardwarePlayability,
  type MouseSettings as MouseSettingsState,
  type MouseStatusKind,
  type NativeModelInfo,
  type OnboardBanks,
} from "../lib/onboard-mapping";
import { PillTrack } from "./PillTrack";
import { dpiStageChoices, dpiStagesForValue } from "../lib/dpi-stages";
import { listenActionExecutionEvent } from "../lib/backend";
import { Notice, SettingRow, Toggle } from "./shared";

export interface MouseWorkspaceProps {
  activeConfig: AppConfig;
  /** The built-in device whose mouse this shows (the selected mouse card). */
  deviceId: string;
  /** "performance": readings, the profile's DPI / poll rate, signals.
   *  "memory": onboard slots and the profile kept for use without Sidearm. */
  section: "performance" | "memory";
  /** Called after a confirmed write to the mouse (the cards re-read it). */
  onWritten?: () => void;
  /** Profiles in the sidebar's order. */
  profiles: Profile[];
  /** The profile being edited — the same selection as the sidebar. */
  activeProfile: Profile | null;
  /** The profile the runtime applies now: its edits reach the mouse at once. */
  runtimeProfileId: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig, options?: { immediate?: boolean }) => void;
  /** Active mouse-path states (`mouse_status`), shown as warnings on top. */
  mouseStates: MouseStatusKind[];
}

const STATE_MESSAGE: Partial<Record<MouseStatusKind, string>> = {
  helperLost: "mouse.statusHelperLost",
  buttonsUnreadable: "mouse.statusButtonsUnreadable",
  mouseUnreachable: "mouse.statusMouseUnreachable",
  watchdogOff: "mouse.statusWatchdogOff",
  mouseOffline: "mouse.statusMouseOffline",
};

/** One mouse's tabs beside its buttons: "performance" (live readings, the
 *  edited profile's own DPI / poll rate for this mouse, side-button signals)
 *  and "memory" (onboard slots, the profile kept for use without Sidearm). */
export function MouseWorkspace({
  activeConfig,
  deviceId,
  section,
  onWritten,
  profiles,
  activeProfile,
  runtimeProfileId,
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
  const target = deviceId;
  const targetRef = useRef(target);
  const [banks, setBanks] = useState<OnboardBanks | null>(null);
  /** The slot Sidearm keeps in the mouse; "Free slot" asks once more before it goes. */
  const [sidearmBank, setSidearmBank] = useState<number | null>(null);
  const [releaseStep, setReleaseStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [slotActionBusy, setSlotActionBusy] = useState(false);
  const [confirmDeleteBank, setConfirmDeleteBank] = useState<number | null>(null);
  const [flushState, setFlushState] = useState<"idle" | "busy" | "done">("idle");
  const [banksVersion, setBanksVersion] = useState(0);

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
      setBanksVersion((v) => v + 1);
      if (descriptor.status === "fulfilled") setModel(descriptor.value);
      if (readings.status === "fulfilled") {
        setDevice(readings.value);
        setReadAt(Date.now());
        setWriteConfirmed(writing);
        if (writing) onWritten?.();
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
    const subscriptions = [
      listenNativeMiceChanged(() => { if (subscribed) refresh(); }),
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
    // The previous mouse's numbers must not stand under this mouse's name.
    setDevice(null);
    setReadAt(null);
    setSummary(null);
    setSummaryCopied(null);
    setReport(null);
    setReportCopied(false);
    setSignalsSwitch(null);
    refresh();
  }, [target]);

  // Clear cached bank inventory only when switching device or disconnecting;
  // background refreshes keep the last known slots to avoid flashing "Connect the mouse".
  useEffect(() => {
    setBanks(null);
    setSidearmBank(null);
    setFlushState("idle");
  }, [model?.deviceId, model?.banks, model?.connected]);

  useEffect(() => {
    if (!model?.banks || !model.connected) return;
    let current = true;
    void getOnboardBanks(model.deviceId).then((next) => { if (current) setBanks(next); }, () => {});
    void getSidearmBank(model.deviceId).then((next) => { if (current) setSidearmBank(next); }, () => {});
    return () => { current = false; };
  }, [model?.deviceId, model?.banks, model?.connected, banksVersion]);

  function notifyBanksChanged() {
    window.dispatchEvent(new Event("sidearm:banks-changed"));
  }

  function releaseSlot(deviceId: string) {
    if (flushState === "busy" || slotActionBusy) return;
    if (releaseStep === "idle") { setReleaseStep("confirm"); return; }
    setReleaseStep("busy");
    setReleaseError(null);
    void releaseSidearmBank(deviceId).then(
      () => {
        if (!lifecycle.current.alive) return;
        setReleaseStep("idle");
        setFlushState("idle");
        setBanksVersion((v) => v + 1);
        notifyBanksChanged();
        onWritten?.();
      },
      (e: unknown) => {
        if (!lifecycle.current.alive) return;
        setReleaseStep("idle");
        setReleaseError(normalizeCommandError(e).message);
      },
    );
  }

  function handleCreateSlot(deviceId: string) {
    if (slotActionBusy || flushState === "busy") return;
    const prevAssigned = new Set(banks?.assigned ?? []);
    const autoBindProfileId =
      activeProfile
      && (activeProfile.deviceSlots?.[deviceId] === undefined || !prevAssigned.has(activeProfile.deviceSlots[deviceId]))
        ? activeProfile.id
        : null;
    setSlotActionBusy(true);
    setConfirmDeleteBank(null);
    setReleaseError(null);
    void createOnboardBank(deviceId).then(
      (next) => {
        if (!lifecycle.current.alive) return;
        const createdBank = next.assigned.find((slot) => !prevAssigned.has(slot));
        if (createdBank !== undefined) {
          if (autoBindProfileId) {
            updateDraft((config) => setProfileDeviceSlot(config, autoBindProfileId, deviceId, createdBank), { immediate: true });
          } else {
            // Clear any stale profile link that previously pointed to this slot number.
            updateDraft((config) => {
              const staleHolder = config.profiles.find((p) => p.deviceSlots?.[deviceId] === createdBank);
              return staleHolder ? setProfileDeviceSlot(config, staleHolder.id, deviceId, undefined) : config;
            }, { immediate: true });
          }
        }
        setBanks(next);
        setFlushState("idle");
        setSlotActionBusy(false);
        setBanksVersion((v) => v + 1);
        notifyBanksChanged();
        onWritten?.();
      },
      (e: unknown) => {
        if (!lifecycle.current.alive) return;
        setSlotActionBusy(false);
        setReleaseError(normalizeCommandError(e).message);
      },
    );
  }

  function handleDeleteSlot(deviceId: string, bank: number, holderId?: string) {
    if (slotActionBusy || flushState === "busy") return;
    if (confirmDeleteBank !== bank) {
      setConfirmDeleteBank(bank);
      return;
    }
    setConfirmDeleteBank(null);
    setSlotActionBusy(true);
    setReleaseError(null);
    void deleteOnboardBank(deviceId, bank).then(
      (next) => {
        if (!lifecycle.current.alive) return;
        if (holderId) {
          updateDraft((config) => setProfileDeviceSlot(config, holderId, deviceId, undefined), { immediate: true });
        }
        setBanks(next);
        setFlushState("idle");
        setSlotActionBusy(false);
        setBanksVersion((v) => v + 1);
        notifyBanksChanged();
        onWritten?.();
      },
      (e: unknown) => {
        if (!lifecycle.current.alive) return;
        setSlotActionBusy(false);
        setReleaseError(normalizeCommandError(e).message);
      },
    );
  }

  function handleFlushBanks(deviceId: string) {
    if (flushState === "busy" || slotActionBusy || releaseStep === "busy") return;
    setFlushState("busy");
    setReleaseError(null);
    void flushOnboardBanks(deviceId, activeConfig).then(
      () => {
        if (!lifecycle.current.alive) return;
        setFlushState("done");
        setBanksVersion((v) => v + 1);
        notifyBanksChanged();
        onWritten?.();
      },
      (e: unknown) => {
        if (!lifecycle.current.alive) return;
        setFlushState("idle");
        setReleaseError(normalizeCommandError(e).message);
      },
    );
  }

  // The profile's own settings for the mouse shown.
  const mouseId = target;
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

  if (section === "memory") {
    const dedicatedOfflineId =
      activeConfig.settings.offlineProfileId
      && activeConfig.settings.offlineProfileId !== OFFLINE_PROFILE_ACTIVE
      && profiles.some((profile) => profile.id === activeConfig.settings.offlineProfileId)
        ? activeConfig.settings.offlineProfileId
        : activeConfig.settings.fallbackProfileId;
    const dedicatedOfflineProfile = profiles.find((profile) => profile.id === dedicatedOfflineId) ?? null;

    if (model?.banks) {
      const MAX_SLOTS = 5;
      const allSlots = [1, 2, 3, 4, 5] as const;
      const assignedSet = new Set(banks?.assigned ?? []);
      const usedSlotsCount = banks ? banks.assigned.length + (sidearmBank !== null ? 1 : 0) : 0;
      const freeSlotsCount = Math.max(0, MAX_SLOTS - usedSlotsCount);
      const nextFreeSlot = banks
        ? allSlots.find((slot) => !assignedSet.has(slot) && slot !== sidearmBank) ?? null
        : null;
      const activeProfileUnlinked = Boolean(
        activeProfile
        && (activeProfile.deviceSlots?.[model.deviceId] === undefined || !assignedSet.has(activeProfile.deviceSlots[model.deviceId])),
      );
      const canAddSlot = banks !== null && nextFreeSlot !== null;
      const canDeleteSlot = banks !== null && banks.assigned.length > 1;
      const linkedHybridCount = banks
        ? banks.assigned.filter((bank) => {
            const holder = profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === bank);
            return Boolean(holder?.enabled && holder.id !== dedicatedOfflineId && holder.deviceMouse?.[model.deviceId]?.hardwareBank);
          }).length
        : 0;
      const allUserBanksHybrid = banks !== null && banks.assigned.length > 0 && linkedHybridCount >= banks.assigned.length;
      const offlineSlotNumber = dedicatedOfflineProfile?.deviceSlots?.[model.deviceId];
      const offlineHardwareBankConflict = Boolean(
        dedicatedOfflineProfile
        && offlineSlotNumber !== undefined
        && dedicatedOfflineProfile.deviceMouse?.[model.deviceId]?.hardwareBank,
      );
      const exitFollowsActive = activeConfig.settings.offlineProfileId === OFFLINE_PROFILE_ACTIVE;
      const fixedExitLabel = dedicatedOfflineProfile
        ? offlineSlotNumber !== undefined
          ? t("mouse.exitFixedSlot", { n: offlineSlotNumber, name: dedicatedOfflineProfile.name })
          : t("mouse.exitFixedProfile", { name: dedicatedOfflineProfile.name })
        : t("mouse.offlineFallback", { name: "" });

      return (
        <div className="settings-shell__content">
          <section className="settings-section memory-v3" aria-label={t("mouse.memoryTitle", { model: model.name })}>
            <div className="memory-v3__header">
              <div className="memory-v3__header-text">
                <h3 className="memory-v3__title">{t("mouse.memoryTitle", { model: model.name })}</h3>
                <p className="panel__muted help-sm">{t("mouse.memoryLead")}</p>
              </div>
              {model.connected && banks !== null ? (
                <button
                  type="button"
                  className="action-button action-button--small"
                  disabled={flushState === "busy" || slotActionBusy || releaseStep === "busy"}
                  onClick={() => handleFlushBanks(model.deviceId)}
                >
                  {flushState === "busy"
                    ? t("mouse.slotsWriting")
                    : flushState === "done"
                    ? t("mouse.slotsWrittenNow")
                    : t("mouse.slotsWriteNow")}
                </button>
              ) : null}
            </div>

            {!model.connected || banks === null ? (
              <p className="panel__muted help-sm">{t("mouse.slotNeedsMouse")}</p>
            ) : (
              <>
                <div className="memory-slot-map" role="list" aria-label={t("mouse.slotMapLabel")}>
                  {allSlots.map((slot) => {
                    if (slot === sidearmBank) {
                      return (
                        <div key={slot} role="listitem" className="memory-slot-tile memory-slot-tile--service">
                          <span className="memory-slot-tile__num">{slot}</span>
                          <span className="memory-slot-tile__name">Sidearm</span>
                          <span className="memory-slot-tile__sub">{t("mouse.slotTileService")}</span>
                        </div>
                      );
                    }
                    if (assignedSet.has(slot)) {
                      const holder = profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === slot);
                      const isOfflineSlot = holder?.id === dedicatedOfflineId;
                      const isDirect = Boolean(holder && !isOfflineSlot && holder.deviceMouse?.[model.deviceId]?.hardwareBank);
                      return (
                        <div
                          key={slot}
                          role="listitem"
                          className={`memory-slot-tile memory-slot-tile--user${isOfflineSlot ? " memory-slot-tile--offline" : isDirect ? " memory-slot-tile--direct" : ""}`}
                        >
                          <span className="memory-slot-tile__num">{slot}</span>
                          <span className="memory-slot-tile__name">{holder ? holder.name : t("mouse.slotTileUnassigned")}</span>
                          <span className="memory-slot-tile__sub">
                            {!holder
                              ? t("mouse.slotKeep")
                              : isOfflineSlot
                              ? t("mouse.slotTileOffline")
                              : isDirect
                              ? t("mouse.slotTileDirect")
                              : t("mouse.slotTileStandard")}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={slot}
                        type="button"
                        className="memory-slot-tile memory-slot-tile--free"
                        disabled={!canAddSlot || slotActionBusy || flushState === "busy"}
                        onClick={() => handleCreateSlot(model.deviceId)}
                      >
                        <span className="memory-slot-tile__num">{slot}</span>
                        <span className="memory-slot-tile__name">{t("mouse.slotTileFree")}</span>
                        <span className="memory-slot-tile__sub">{t("mouse.slotTileAdd")}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="memory-slot-cards">
                  {banks.assigned.map((bank) => {
                    const holder = profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === bank);
                    const isDedicatedOffline = holder?.id === dedicatedOfflineId;
                    const hardwareBankOn = Boolean(holder && !isDedicatedOffline && holder.deviceMouse?.[model.deviceId]?.hardwareBank);
                    const holderCounts = holder
                      ? summarizeProfileHardwarePlayability(activeConfig, holder.id, model.deviceId, { checkHs2: true })
                      : null;
                    const hybridStatus = holder
                      ? evaluateHybridBankStatus(activeConfig, holder.id, model.deviceId, {
                          isDedicatedOffline,
                          userBankCount: banks.assigned.length,
                          consumerSignals: model.consumerSignals,
                          allUserBanksHybrid,
                        })
                      : null;
                    const hybridStatusText = (() => {
                      if (!hybridStatus || isDedicatedOffline) return null;
                      if (hardwareBankOn) {
                        if (hybridStatus.blocker === "singleUserBank") return { variant: "warn" as const, text: t("mouse.hardwareBankNeedSecondSlot") };
                        if (hybridStatus.blocker === "keySignalsMode") return { variant: "warn" as const, text: t("mouse.hardwareBankNeedConsumer") };
                        if (hybridStatus.blocker === "hs2Trigger") return { variant: "warn" as const, text: t("mouse.hardwareBankHs2Blocker") };
                        if (hybridStatus.blocker === "noNativeKeys") return { variant: "muted" as const, text: t("mouse.hardwareBankZeroNative") };
                        return {
                          variant: "ok" as const,
                          text: t("mouse.hardwareBankActiveSummary", {
                            native: hybridStatus.nativeCount,
                            sidearm: hybridStatus.sidearmCount,
                          }),
                        };
                      }
                      if (hybridStatus.blocker === "hs2Trigger") {
                        return { variant: "muted" as const, text: t("mouse.hardwareBankHs2Blocker") };
                      }
                      if (hybridStatus.blocker === "singleUserBank") {
                        return { variant: "muted" as const, text: t("mouse.hardwareBankNeedSecondSlot") };
                      }
                      return null;
                    })();
                    const confirmingDelete = confirmDeleteBank === bank;

                    return (
                      <div key={bank} className="memory-slot-card">
                        <div className="memory-slot-card__head">
                          <div className="memory-slot-card__head-main">
                            <strong className="memory-slot-card__title">{t("mouse.slotRow", { n: bank })}</strong>
                            {holder && holderCounts ? (
                              <span className="offline-fix__meta-pill">
                                {t("mouse.slotKeyCount", { inMouse: holderCounts.inMouse })}
                              </span>
                            ) : null}
                            {isDedicatedOffline ? (
                              <span className="memory-slot-card__role-pill memory-slot-card__role-pill--offline">
                                {t("mouse.slotRoleOfflineBadge")}
                              </span>
                            ) : hardwareBankOn && hybridStatus?.willActivate ? (
                              <span className="memory-slot-card__role-pill memory-slot-card__role-pill--direct">
                                {t("mouse.slotRoleDirectBadge")}
                              </span>
                            ) : null}
                          </div>
                          {canDeleteSlot ? (
                            <button
                              type="button"
                              className={`action-button action-button--small${confirmingDelete ? " action-button--danger" : " action-button--secondary"}`}
                              disabled={slotActionBusy || flushState === "busy"}
                              onClick={() => handleDeleteSlot(model.deviceId, bank, holder?.id)}
                              onBlur={() => { if (confirmDeleteBank === bank) setConfirmDeleteBank(null); }}
                            >
                              {confirmingDelete ? t("mouse.slotDeleteConfirm") : t("mouse.slotDelete")}
                            </button>
                          ) : null}
                        </div>

                        <div className="memory-slot__controls">
                          <PillTrack
                            items={[
                              { key: "", label: t("mouse.slotKeep") },
                              ...profiles.map((profile) => ({ key: profile.id, label: profile.name })),
                            ]}
                            active={holder?.id ?? ""}
                            onSelect={(profileId) => {
                              setFlushState("idle");
                              updateDraft(
                                (config) => profileId
                                  ? setProfileDeviceSlot(config, profileId, model.deviceId, bank)
                                  : holder ? setProfileDeviceSlot(config, holder.id, model.deviceId, undefined) : config,
                                { immediate: true },
                              );
                            }}
                          />
                        </div>

                        {holder ? (
                          <div className="memory-slot-card__footer">
                            {isDedicatedOffline ? (
                              <>
                                <p className="panel__muted help-sm memory-slot-card__offline-note">
                                  {t("mouse.hardwareBankOfflineGuard")}
                                </p>
                                {offlineHardwareBankConflict ? (
                                  <Notice variant="warning">
                                    <p>{t("mouse.hardwareBankOfflineConflict", { name: holder.name })}</p>
                                    <button
                                      type="button"
                                      className="action-button action-button--secondary action-button--small mt-8"
                                      onClick={() => updateDraft((config) => setProfileMouse(config, holder.id, model.deviceId, { hardwareBank: false }), { immediate: true })}
                                    >
                                      {t("mouse.hardwareBankTurnOff")}
                                    </button>
                                  </Notice>
                                ) : null}
                              </>
                            ) : (
                              <div className="memory-slot-card__mode-row">
                                <div className="memory-slot-card__direct">
                                  <div className="memory-slot-card__direct-head">
                                    <Toggle
                                      checked={hardwareBankOn}
                                      ariaLabel={t("mouse.hardwareBankTitle", { name: holder.name })}
                                      onChange={(checked) => {
                                        setFlushState("idle");
                                        updateDraft((config) => setProfileMouse(config, holder.id, model.deviceId, { hardwareBank: checked }), { immediate: true });
                                      }}
                                    />
                                    <div className="memory-slot-card__direct-text">
                                      <span className="memory-slot-card__direct-title">{t("mouse.directKeysLabel")}</span>
                                      <span className="panel__muted help-sm">{t("mouse.hardwareBankHint")}</span>
                                    </div>
                                  </div>
                                  {hybridStatusText ? (
                                    <span className={`memory-hybrid__status memory-hybrid__status--${hybridStatusText.variant}`}>
                                      {hybridStatusText.text}
                                    </span>
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  className="action-button action-button--secondary action-button--small"
                                  onClick={() => {
                                    setFlushState("idle");
                                    updateDraft((config) => {
                                      const cleared = holder.deviceMouse?.[model.deviceId]?.hardwareBank
                                        ? setProfileMouse(config, holder.id, model.deviceId, { hardwareBank: false })
                                        : config;
                                      return {
                                        ...cleared,
                                        settings: {
                                          ...cleared.settings,
                                          offlineProfileId: holder.id === cleared.settings.fallbackProfileId ? undefined : holder.id,
                                        },
                                      };
                                    }, { immediate: true });
                                  }}
                                >
                                  {t("mouse.makeOfflineSlot")}
                                </button>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {canAddSlot && nextFreeSlot !== null ? (
                    <div className="memory-slot-card memory-slot-card--add">
                      <span className="panel__muted help-sm">
                        {t("mouse.slotsFreeSummary", { free: freeSlotsCount, max: MAX_SLOTS })}
                      </span>
                      <button
                        type="button"
                        className="action-button action-button--secondary action-button--small"
                        disabled={slotActionBusy || flushState === "busy"}
                        onClick={() => handleCreateSlot(model.deviceId)}
                      >
                        {activeProfileUnlinked && activeProfile
                          ? t("mouse.slotAddProfileNext", { name: activeProfile.name, n: nextFreeSlot })
                          : t("mouse.slotAddNext", { n: nextFreeSlot })}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="memory-v3__exit-row">
                  <SettingRow title={t("mouse.exitBehaviorTitle")} hint={t("mouse.exitBehaviorHint")}>
                    <PillTrack
                      items={[
                        { key: "fixed", label: fixedExitLabel },
                        { key: OFFLINE_PROFILE_ACTIVE, label: t("mouse.offlineActive") },
                      ]}
                      active={exitFollowsActive ? OFFLINE_PROFILE_ACTIVE : "fixed"}
                      onSelect={(mode) => {
                        setFlushState("idle");
                        updateDraft((config) => ({
                          ...config,
                          settings: {
                            ...config.settings,
                            offlineProfileId: mode === OFFLINE_PROFILE_ACTIVE
                              ? OFFLINE_PROFILE_ACTIVE
                              : dedicatedOfflineId === config.settings.fallbackProfileId
                              ? undefined
                              : dedicatedOfflineId,
                          },
                        }), { immediate: true });
                      }}
                    />
                  </SettingRow>
                </div>

                {sidearmBank !== null ? (
                  <div className="memory-service-row">
                    <div className="memory-service-row__text">
                      <span className="memory-service-row__title">{t("mouse.sidearmSlotRow", { n: sidearmBank })}</span>
                      <span className="panel__muted help-sm">{t("mouse.sidearmSlotHelp")}</span>
                    </div>
                    <button
                      type="button"
                      className="action-button action-button--secondary action-button--small"
                      disabled={releaseStep === "busy" || slotActionBusy || flushState === "busy"}
                      onClick={() => releaseSlot(model.deviceId)}
                      onBlur={() => { if (releaseStep === "confirm") setReleaseStep("idle"); }}
                    >
                      {releaseStep === "confirm" ? t("mouse.sidearmSlotConfirm") : t("mouse.sidearmSlotRelease")}
                    </button>
                  </div>
                ) : null}

                {releaseError ? (
                  <Notice variant="warning">
                    <p>{releaseError}</p>
                  </Notice>
                ) : null}
              </>
            )}
          </section>
        </div>
      );
    }

    const memoryCounts = activeProfile
      ? summarizeProfileHardwarePlayability(activeConfig, activeProfile.id, target, { checkHs2: false })
      : null;

    return (
      <div className="settings-shell__content">
      {activeProfile && memoryCounts ? (
        <section className="settings-section" aria-label={t("offline.memorySummaryTitle", { name: activeProfile.name })}>
          <SettingRow title={t("offline.memorySummaryTitle", { name: activeProfile.name })}>
            <div className="memory-summary__pills">
              <span className="offline-fix__meta-pill offline-fix__meta-pill--accent">
                {t("offline.memoryInMousePill", { count: memoryCounts.inMouse })}
              </span>
              <span className="offline-fix__meta-pill">
                {t("offline.memorySidearmPill", { count: memoryCounts.sidearmOnly })}
              </span>
            </div>
          </SettingRow>
        </section>
      ) : null}

      <section className="settings-section">
        <SettingRow title={t("mouse.offlineHeader")} hint={t("mouse.offlineHelp")}>
          <PillTrack
            items={[
              {
                key: "",
                label: t("mouse.offlineFallback", {
                  name: profiles.find((p) => p.id === activeConfig.settings.fallbackProfileId)?.name ?? "",
                }),
              },
              { key: OFFLINE_PROFILE_ACTIVE, label: t("mouse.offlineActive") },
              ...profiles
                .filter((profile) => profile.id !== activeConfig.settings.fallbackProfileId)
                .map((profile) => ({ key: profile.id, label: profile.name })),
            ]}
            active={activeConfig.settings.offlineProfileId ?? ""}
            onSelect={(id) => {
              setFlushState("idle");
              updateDraft((config) => ({
                ...config,
                settings: { ...config.settings, offlineProfileId: id || undefined },
              }), { immediate: true });
            }}
          />
        </SettingRow>
      </section>
      </div>
    );
  }

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

    </div>
  );
}
