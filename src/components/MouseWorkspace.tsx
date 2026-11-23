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
  moveSidearmBank,
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
import { ContextMenu } from "./ContextMenu";
import { PillTrack } from "./PillTrack";
import { dpiStageChoices, dpiStagesForValue } from "../lib/dpi-stages";
import { listenActionExecutionEvent } from "../lib/backend";
import { MEMORY_SLOT_DRAG_TYPE, PROFILE_DRAG_TYPE } from "../lib/mouse-visual";
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
  /** Opens the Buttons view for a given profile (from a memory slot context menu). */
  onOpenProfileButtons?: (profileId: string) => void;
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
  onOpenProfileButtons,
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
  const [selectedSlot, setSelectedSlot] = useState<number>(1);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [slotCtxMenu, setSlotCtxMenu] = useState<{ x: number; y: number; slot: number } | null>(null);
  const slotInitDeviceRef = useRef<string | null>(null);

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
    setDragOverSlot(null);
    setConfirmDeleteBank(null);
    slotInitDeviceRef.current = null;
  }, [model?.deviceId, model?.banks, model?.connected]);

  useEffect(() => {
    if (!model?.deviceId || !banks || slotInitDeviceRef.current === model.deviceId) return;
    slotInitDeviceRef.current = model.deviceId;
    const activeSlot = activeProfile?.deviceSlots?.[model.deviceId];
    if (activeSlot !== undefined && banks.assigned.includes(activeSlot)) {
      setSelectedSlot(activeSlot);
    } else if (banks.assigned.length > 0) {
      setSelectedSlot(banks.assigned[0]);
    } else {
      setSelectedSlot(1);
    }
  }, [model?.deviceId, banks, activeProfile]);

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

  /** Moves Sidearm's service bank to `targetBank` (typically slot 5) immediately,
   *  automatically remapping any displaced user profile's slot link in config. */
  function handleMoveSidearmBank(deviceId: string, targetBank: number) {
    if (slotActionBusy || flushState === "busy" || releaseStep === "busy") return;
    if (sidearmBank === null || sidearmBank === targetBank) return;
    setSlotActionBusy(true);
    setConfirmDeleteBank(null);
    setReleaseStep("idle");
    setReleaseError(null);
    void moveSidearmBank(deviceId, targetBank).then(
      (res) => {
        if (!lifecycle.current.alive) return;
        if (res.displacedFrom !== null && res.displacedTo !== null) {
          const fromSlot = res.displacedFrom;
          const toSlot = res.displacedTo;
          updateDraft((config) => {
            const displaced = config.profiles.find((p) => p.deviceSlots?.[deviceId] === fromSlot);
            return displaced ? setProfileDeviceSlot(config, displaced.id, deviceId, toSlot) : config;
          }, { immediate: true });
        }
        setSidearmBank(res.sidearm);
        setBanks(res.banks);
        setSelectedSlot(res.sidearm);
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

  /** Assigns a Sidearm profile to a specific hardware slot (1..5), creating that
   *  exact slot on the mouse first when it is currently empty. When moving from
   *  another slot, swaps occupied slots or cleans up the vacated source slot. */
  function assignProfileToSlot(deviceId: string, targetSlot: number, profileId: string, moveFromSlot?: number) {
    if (slotActionBusy || flushState === "busy" || targetSlot === sidearmBank) return;
    setConfirmDeleteBank(null);
    setReleaseError(null);

    if (banks?.assigned.includes(targetSlot)) {
      setSelectedSlot(targetSlot);
      setFlushState("idle");
      updateDraft((config) => {
        const targetHolder = config.profiles.find((p) => p.deviceSlots?.[deviceId] === targetSlot);
        let next = setProfileDeviceSlot(config, profileId, deviceId, targetSlot);
        if (
          moveFromSlot !== undefined
          && moveFromSlot !== targetSlot
          && targetHolder
          && targetHolder.id !== profileId
        ) {
          next = setProfileDeviceSlot(next, targetHolder.id, deviceId, moveFromSlot);
        }
        return next;
      }, { immediate: true });
      return;
    }

    setSlotActionBusy(true);
    void createOnboardBank(deviceId, targetSlot).then(
      async (next) => {
        if (!lifecycle.current.alive) return;
        updateDraft((config) => setProfileDeviceSlot(config, profileId, deviceId, targetSlot), { immediate: true });
        setSelectedSlot(targetSlot);
        let finalBanks = next;
        if (moveFromSlot !== undefined && moveFromSlot !== targetSlot && next.assigned.includes(moveFromSlot)) {
          try {
            finalBanks = await deleteOnboardBank(deviceId, moveFromSlot);
          } catch {
            // Keep the moved profile even if hardware safety guards keep the previous slot.
          }
        }
        if (!lifecycle.current.alive) return;
        setBanks(finalBanks);
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

  function handleDeleteSlot(deviceId: string, bank: number, holderId?: string, skipConfirm = false) {
    if (slotActionBusy || flushState === "busy") return;
    if (!skipConfirm && confirmDeleteBank !== bank) {
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
      const allSlots = [1, 2, 3, 4, 5] as const;
      const assignedSet = new Set(banks?.assigned ?? []);
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

      const activeSelectedSlot = allSlots.includes(selectedSlot as 1 | 2 | 3 | 4 | 5) ? selectedSlot : 1;
      const selectedIsService = activeSelectedSlot === sidearmBank;
      const selectedIsAssigned = !selectedIsService && assignedSet.has(activeSelectedSlot);
      const selectedHolder = selectedIsAssigned
        ? profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === activeSelectedSlot) ?? null
        : null;
      const selectedIsDedicatedOffline = selectedHolder?.id === dedicatedOfflineId;
      const selectedHardwareBankOn = Boolean(
        selectedHolder && !selectedIsDedicatedOffline && selectedHolder.deviceMouse?.[model.deviceId]?.hardwareBank,
      );
      const selectedHolderCounts = selectedHolder
        ? summarizeProfileHardwarePlayability(activeConfig, selectedHolder.id, model.deviceId, { checkHs2: true })
        : null;
      const selectedHybridStatus = selectedHolder
        ? evaluateHybridBankStatus(activeConfig, selectedHolder.id, model.deviceId, {
            isDedicatedOffline: selectedIsDedicatedOffline,
            userBankCount: banks?.assigned.length ?? 0,
            consumerSignals: model.consumerSignals,
            allUserBanksHybrid,
          })
        : null;
      const selectedHybridNotice = (() => {
        if (!selectedHybridStatus || selectedIsDedicatedOffline) return null;
        if (selectedHardwareBankOn) {
          if (selectedHybridStatus.blocker === "singleUserBank") return { variant: "warn" as const, text: t("mouse.hardwareBankNeedSecondSlot") };
          if (selectedHybridStatus.blocker === "keySignalsMode") return { variant: "warn" as const, text: t("mouse.hardwareBankNeedConsumer") };
          if (selectedHybridStatus.blocker === "hs2Trigger") return { variant: "warn" as const, text: t("mouse.hardwareBankHs2Blocker") };
          if (selectedHybridStatus.blocker === "noNativeKeys") return { variant: "muted" as const, text: t("mouse.hardwareBankZeroNative") };
          return {
            variant: "ok" as const,
            text: t("mouse.hardwareBankActiveSummary", {
              native: selectedHybridStatus.nativeCount,
              sidearm: selectedHybridStatus.sidearmCount,
            }),
          };
        }
        if (selectedHybridStatus.blocker === "hs2Trigger") return { variant: "muted" as const, text: t("mouse.hardwareBankHs2Blocker") };
        if (selectedHybridStatus.blocker === "singleUserBank") return { variant: "muted" as const, text: t("mouse.hardwareBankNeedSecondSlot") };
        if (selectedHybridStatus.blocker === "keySignalsMode") return { variant: "muted" as const, text: t("mouse.hardwareBankNeedConsumer") };
        if (selectedHybridStatus.nativeCount > 0) {
          return {
            variant: "muted" as const,
            text: t("mouse.hardwareBankReadySummary", { count: selectedHybridStatus.nativeCount }),
          };
        }
        return null;
      })();

      const isProfileOrSlotDrag = (e: React.DragEvent) => {
        const types = Array.from(e.dataTransfer.types);
        return types.includes(PROFILE_DRAG_TYPE) || types.includes(MEMORY_SLOT_DRAG_TYPE);
      };

      const renderProfilePickerGrid = (targetSlot: number) => (
        <div className="memory-profile-grid" role="group" aria-label={t("mouse.slotPickProfileLabel")}>
          {profiles.map((profile) => {
            const counts = summarizeProfileHardwarePlayability(activeConfig, profile.id, model.deviceId, { checkHs2: true });
            const existingSlot = profile.deviceSlots?.[model.deviceId];
            const inOtherSlot = existingSlot !== undefined && assignedSet.has(existingSlot) && existingSlot !== targetSlot;
            return (
              <button
                key={profile.id}
                type="button"
                className="memory-profile-pick"
                disabled={slotActionBusy || flushState === "busy"}
                onClick={() => assignProfileToSlot(model.deviceId, targetSlot, profile.id)}
              >
                <span className="memory-profile-pick__top">
                  <strong className="memory-profile-pick__name">{profile.name}</strong>
                  {inOtherSlot ? (
                    <span className="memory-profile-pick__badge">{t("mouse.slotRow", { n: existingSlot })}</span>
                  ) : null}
                </span>
                <span className="memory-profile-pick__meta">
                  {t("mouse.slotKeyCount", { inMouse: counts.inMouse })}
                </span>
              </button>
            );
          })}
        </div>
      );

      const renderSlotTile = (slot: 1 | 2 | 3 | 4 | 5) => {
        const isSelected = activeSelectedSlot === slot;
        const isService = slot === sidearmBank;
        const isAssigned = !isService && assignedSet.has(slot);
        const holder = isAssigned
          ? profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === slot) ?? null
          : null;
        const isOfflineSlot = holder?.id === dedicatedOfflineId;
        const isDirect = Boolean(holder && !isOfflineSlot && holder.deviceMouse?.[model.deviceId]?.hardwareBank);
        const isExternal = isAssigned && !holder;
        const isFree = !isService && !isAssigned;
        const isDropTarget = dragOverSlot === slot;

        const tileClass = [
          "memory-slot-tile",
          isService
            ? "memory-slot-tile--service"
            : isFree
            ? "memory-slot-tile--free"
            : isExternal
            ? "memory-slot-tile--external"
            : isOfflineSlot
            ? "memory-slot-tile--offline"
            : isDirect
            ? "memory-slot-tile--direct"
            : "memory-slot-tile--user",
          isSelected ? "memory-slot-tile--selected" : "",
          isDropTarget ? "memory-slot-tile--drop" : "",
        ].filter(Boolean).join(" ");

        const tileName = isService
          ? "Sidearm"
          : isFree
          ? t("mouse.slotTileFree")
          : isExternal
          ? t("mouse.slotTileExternal")
          : holder!.name;

        const tileSub = isDropTarget
          ? t("mouse.slotDropHere")
          : isService
          ? (slot !== 5 ? t("mouse.slotTileServiceMove") : t("mouse.slotTileService"))
          : isFree
          ? t("mouse.slotTileDropHint")
          : isExternal
          ? t("mouse.slotTileExternalSub")
          : isOfflineSlot
          ? t("mouse.slotTileOffline")
          : isDirect
          ? t("mouse.slotTileDirect")
          : t("mouse.slotTileStandard");

        return (
          <button
            key={slot}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-label={`${t("mouse.slotRow", { n: slot })}: ${tileName}`}
            className={tileClass}
            draggable={Boolean(holder) || isService}
            onClick={() => {
              setSelectedSlot(slot);
              setConfirmDeleteBank(null);
              setReleaseStep("idle");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelectedSlot(slot);
              setSlotCtxMenu({ x: e.clientX, y: e.clientY, slot });
            }}
            onDragStart={(e) => {
              if (!holder && !isService) { e.preventDefault(); return; }
              e.dataTransfer.effectAllowed = "move";
              if (holder) e.dataTransfer.setData(PROFILE_DRAG_TYPE, holder.id);
              e.dataTransfer.setData(MEMORY_SLOT_DRAG_TYPE, String(slot));
            }}
            onDragOver={(e) => {
              if (slotActionBusy || flushState === "busy" || !isProfileOrSlotDrag(e)) return;
              // Sidebar profiles cannot drop directly onto Sidearm's service slot;
              // only another slot (or Sidearm itself) can swap/relocate with it.
              const types = Array.from(e.dataTransfer.types);
              if (isService && !types.includes(MEMORY_SLOT_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverSlot !== slot) setDragOverSlot(slot);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              if (dragOverSlot === slot) setDragOverSlot(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverSlot(null);
              if (slotActionBusy || flushState === "busy") return;
              const fromRaw = e.dataTransfer.getData(MEMORY_SLOT_DRAG_TYPE);
              const fromSlot = fromRaw ? Number(fromRaw) : undefined;
              if (fromSlot === slot) {
                setSelectedSlot(slot);
                return;
              }
              if (sidearmBank !== null && fromSlot === sidearmBank) {
                handleMoveSidearmBank(model.deviceId, slot);
                return;
              }
              if (isService && fromSlot !== undefined && Number.isInteger(fromSlot)) {
                handleMoveSidearmBank(model.deviceId, fromSlot);
                return;
              }
              if (isService) return;
              const profileId = e.dataTransfer.getData(PROFILE_DRAG_TYPE);
              if (!profileId || !profiles.some((p) => p.id === profileId)) return;
              assignProfileToSlot(model.deviceId, slot, profileId, Number.isInteger(fromSlot) ? fromSlot : undefined);
            }}
          >
            <span className="memory-slot-tile__top">
              <span className="memory-slot-tile__num">{slot}</span>
              {holder || isService ? <span className="memory-slot-tile__grip" aria-hidden="true">⋮⋮</span> : null}
            </span>
            <span className="memory-slot-tile__name">{tileName}</span>
            <span className="memory-slot-tile__sub">{tileSub}</span>
          </button>
        );
      };

      return (
        <div className="settings-shell__content">
          <section className="settings-section memory-board" aria-label={t("mouse.memoryTitle", { model: model.name })}>
            <div className="memory-board__header">
              <div className="memory-board__header-text">
                <h3 className="memory-board__title">{t("mouse.memoryTitle", { model: model.name })}</h3>
                <p className="panel__muted help-sm">{t("mouse.memoryBoardLead")}</p>
              </div>
              {model.connected && banks !== null ? (
                <div className="memory-board__header-actions">
                  {sidearmBank !== null && sidearmBank !== 5 ? (
                    <button
                      type="button"
                      className="action-button action-button--secondary action-button--small"
                      disabled={slotActionBusy || flushState === "busy" || releaseStep === "busy"}
                      onClick={() => handleMoveSidearmBank(model.deviceId, 5)}
                    >
                      {t("mouse.sidearmMoveTo5Short")}
                    </button>
                  ) : null}
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
                </div>
              ) : null}
            </div>

            {!model.connected || banks === null ? (
              <p className="panel__muted help-sm">{t("mouse.slotNeedsMouse")}</p>
            ) : (
              <>
                <div className="memory-slot-strip memory-slot-strip--split" role="tablist" aria-label={t("mouse.slotMapLabel")}>
                  {([1, 2, 3, 4] as const).map(renderSlotTile)}
                  <div className="memory-slot-strip__sep" aria-hidden="true" />
                  {renderSlotTile(5)}
                </div>

                <div className="memory-inspector" role="tabpanel" aria-label={t("mouse.slotRow", { n: activeSelectedSlot })}>
                  {selectedIsService ? (
                    <>
                      <div className="memory-inspector__head">
                        <div className="memory-inspector__head-main">
                          <span className="memory-inspector__slot-pill">{t("mouse.slotRow", { n: activeSelectedSlot })}</span>
                          <strong className="memory-inspector__title">{t("mouse.sidearmSlotInspectorTitle")}</strong>
                          <span className="memory-inspector__tag">{t("mouse.slotTileService")}</span>
                        </div>
                        <div className="memory-inspector__actions">
                          {sidearmBank !== 5 ? (
                            <button
                              type="button"
                              className="action-button action-button--small"
                              disabled={releaseStep === "busy" || slotActionBusy || flushState === "busy"}
                              onClick={() => handleMoveSidearmBank(model.deviceId, 5)}
                            >
                              {t("mouse.sidearmMoveTo5Now")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={`action-button action-button--small${releaseStep === "confirm" ? " action-button--danger" : " action-button--secondary"}`}
                            disabled={releaseStep === "busy" || slotActionBusy || flushState === "busy"}
                            onClick={() => releaseSlot(model.deviceId)}
                            onBlur={() => { if (releaseStep === "confirm") setReleaseStep("idle"); }}
                          >
                            {releaseStep === "confirm" ? t("mouse.sidearmSlotConfirm") : t("mouse.sidearmSlotRelease")}
                          </button>
                        </div>
                      </div>
                      <p className="memory-inspector__desc">{t("mouse.sidearmSlotWhy")}</p>
                      {sidearmBank !== 5 ? (
                        <p className="panel__muted help-sm memory-inspector__note">{t("mouse.sidearmSlotMoveHint")}</p>
                      ) : null}
                      <p className="panel__muted help-sm memory-inspector__note">{t("mouse.sidearmSlotReleaseHint")}</p>
                    </>
                  ) : !selectedIsAssigned ? (
                    <>
                      <div className="memory-inspector__head">
                        <div className="memory-inspector__head-main">
                          <span className="memory-inspector__slot-pill">{t("mouse.slotRow", { n: activeSelectedSlot })}</span>
                          <strong className="memory-inspector__title">{t("mouse.slotEmptyTitle")}</strong>
                        </div>
                      </div>
                      <p className="memory-inspector__desc">{t("mouse.slotEmptyDesc")}</p>
                      {renderProfilePickerGrid(activeSelectedSlot)}
                    </>
                  ) : !selectedHolder ? (
                    <>
                      <div className="memory-inspector__head">
                        <div className="memory-inspector__head-main">
                          <span className="memory-inspector__slot-pill">{t("mouse.slotRow", { n: activeSelectedSlot })}</span>
                          <strong className="memory-inspector__title">{t("mouse.slotExternalTitle")}</strong>
                          <span className="memory-inspector__tag memory-inspector__tag--warn">{t("mouse.slotTileExternalSub")}</span>
                        </div>
                        {canDeleteSlot ? (
                          <button
                            type="button"
                            className="action-button action-button--small action-button--secondary"
                            disabled={slotActionBusy || flushState === "busy"}
                            onClick={() => handleDeleteSlot(model.deviceId, activeSelectedSlot, undefined, true)}
                          >
                            {t("mouse.slotClearUnlinked")}
                          </button>
                        ) : null}
                      </div>
                      <p className="memory-inspector__desc">{t("mouse.slotExternalDesc")}</p>
                      {renderProfilePickerGrid(activeSelectedSlot)}
                    </>
                  ) : (
                    <>
                      <div className="memory-inspector__head">
                        <div className="memory-inspector__head-main">
                          <span className="memory-inspector__slot-pill">{t("mouse.slotRow", { n: activeSelectedSlot })}</span>
                          <strong className="memory-inspector__title">{selectedHolder.name}</strong>
                          {selectedHolderCounts ? (
                            <span className="offline-fix__meta-pill">
                              {t("mouse.slotKeyCount", { inMouse: selectedHolderCounts.inMouse })}
                            </span>
                          ) : null}
                          {selectedIsDedicatedOffline ? (
                            <span className="memory-slot-card__role-pill memory-slot-card__role-pill--offline">
                              {t("mouse.slotRoleOfflineBadge")}
                            </span>
                          ) : selectedHardwareBankOn && selectedHybridStatus?.willActivate ? (
                            <span className="memory-slot-card__role-pill memory-slot-card__role-pill--direct">
                              {t("mouse.slotRoleDirectBadge")}
                            </span>
                          ) : null}
                        </div>
                        {canDeleteSlot ? (
                          <button
                            type="button"
                            className={`action-button action-button--small${confirmDeleteBank === activeSelectedSlot ? " action-button--danger" : " action-button--secondary"}`}
                            disabled={slotActionBusy || flushState === "busy"}
                            onClick={() => handleDeleteSlot(model.deviceId, activeSelectedSlot, selectedHolder.id)}
                            onBlur={() => { if (confirmDeleteBank === activeSelectedSlot) setConfirmDeleteBank(null); }}
                          >
                            {confirmDeleteBank === activeSelectedSlot ? t("mouse.slotDeleteConfirm") : t("mouse.slotDelete")}
                          </button>
                        ) : null}
                      </div>

                      <div className="memory-inspector__switcher">
                        <span className="memory-inspector__label">{t("mouse.slotProfileLabel")}</span>
                        <PillTrack
                          items={profiles.map((profile) => ({ key: profile.id, label: profile.name }))}
                          active={selectedHolder.id}
                          onSelect={(profileId) => assignProfileToSlot(model.deviceId, activeSelectedSlot, profileId)}
                        />
                      </div>

                      <div className="memory-mode-grid">
                        <div className={`memory-mode-card${!selectedHardwareBankOn ? " memory-mode-card--active" : ""}`}>
                          <button
                            type="button"
                            className="memory-mode-card__select"
                            aria-pressed={!selectedHardwareBankOn}
                            onClick={() => {
                              if (!selectedHardwareBankOn) return;
                              setFlushState("idle");
                              updateDraft(
                                (config) => setProfileMouse(config, selectedHolder.id, model.deviceId, { hardwareBank: false }),
                                { immediate: true },
                              );
                            }}
                          >
                            <span className="memory-mode-card__head">
                              <span className={`memory-mode-card__radio${!selectedHardwareBankOn ? " memory-mode-card__radio--on" : ""}`} aria-hidden="true" />
                              <strong className="memory-mode-card__title">{t("mouse.modeOfflineTitle")}</strong>
                            </span>
                            <span className="memory-mode-card__desc">{t("mouse.modeOfflineDesc")}</span>
                          </button>
                          <div className="memory-mode-card__foot">
                            {selectedIsDedicatedOffline ? (
                              <span className="memory-hybrid__status memory-hybrid__status--ok">
                                {t("mouse.modeOfflineDefaultBadge")}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="action-button action-button--secondary action-button--small"
                                onClick={() => {
                                  setFlushState("idle");
                                  updateDraft((config) => {
                                    const cleared = selectedHolder.deviceMouse?.[model.deviceId]?.hardwareBank
                                      ? setProfileMouse(config, selectedHolder.id, model.deviceId, { hardwareBank: false })
                                      : config;
                                    return {
                                      ...cleared,
                                      settings: {
                                        ...cleared.settings,
                                        offlineProfileId: selectedHolder.id === cleared.settings.fallbackProfileId ? undefined : selectedHolder.id,
                                      },
                                    };
                                  }, { immediate: true });
                                }}
                              >
                                {t("mouse.makeOfflineSlot")}
                              </button>
                            )}
                          </div>
                        </div>

                        <div
                          className={`memory-mode-card${selectedHardwareBankOn ? " memory-mode-card--active" : ""}${selectedIsDedicatedOffline ? " memory-mode-card--locked" : ""}`}
                        >
                          <button
                            type="button"
                            className="memory-mode-card__select"
                            aria-pressed={selectedHardwareBankOn}
                            disabled={selectedIsDedicatedOffline}
                            onClick={() => {
                              if (selectedIsDedicatedOffline || selectedHardwareBankOn) return;
                              setFlushState("idle");
                              updateDraft(
                                (config) => setProfileMouse(config, selectedHolder.id, model.deviceId, { hardwareBank: true }),
                                { immediate: true },
                              );
                            }}
                          >
                            <span className="memory-mode-card__head">
                              <span className={`memory-mode-card__radio${selectedHardwareBankOn ? " memory-mode-card__radio--on" : ""}`} aria-hidden="true" />
                              <strong className="memory-mode-card__title">{t("mouse.modeDirectTitle")}</strong>
                            </span>
                            <span className="memory-mode-card__desc">{t("mouse.hardwareBankHint")}</span>
                          </button>
                          <div className="memory-mode-card__foot">
                            {selectedIsDedicatedOffline ? (
                              <span className="panel__muted help-sm">{t("mouse.modeDirectOfflineLocked")}</span>
                            ) : selectedHybridNotice ? (
                              <span className={`memory-hybrid__status memory-hybrid__status--${selectedHybridNotice.variant}`}>
                                {selectedHybridNotice.text}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {selectedIsDedicatedOffline && offlineHardwareBankConflict ? (
                        <Notice variant="warning">
                          <p>{t("mouse.hardwareBankOfflineConflict", { name: selectedHolder.name })}</p>
                          <button
                            type="button"
                            className="action-button action-button--secondary action-button--small mt-8"
                            onClick={() => updateDraft((config) => setProfileMouse(config, selectedHolder.id, model.deviceId, { hardwareBank: false }), { immediate: true })}
                          >
                            {t("mouse.hardwareBankTurnOff")}
                          </button>
                        </Notice>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="memory-board__exit">
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

                {releaseError ? (
                  <Notice variant="warning">
                    <p>{releaseError}</p>
                  </Notice>
                ) : null}

                {slotCtxMenu ? (() => {
                  const slot = slotCtxMenu.slot;
                  const isService = slot === sidearmBank;
                  const isAssigned = !isService && assignedSet.has(slot);
                  const holder = isAssigned
                    ? profiles.find((profile) => profile.deviceSlots?.[model.deviceId] === slot) ?? null
                    : null;
                  const isDedicated = holder?.id === dedicatedOfflineId;
                  const directOn = Boolean(holder && !isDedicated && holder.deviceMouse?.[model.deviceId]?.hardwareBank);
                  const items = isService
                    ? [
                        ...(slot !== 5
                          ? [{
                              label: t("mouse.sidearmMoveTo5Now"),
                              disabled: slotActionBusy || flushState === "busy" || releaseStep === "busy",
                              onClick: () => handleMoveSidearmBank(model.deviceId, 5),
                            }]
                          : []),
                        {
                          label: t("mouse.sidearmSlotRelease"),
                          danger: true,
                          disabled: slotActionBusy || flushState === "busy" || releaseStep === "busy",
                          onClick: () => {
                            setReleaseStep("confirm");
                            releaseSlot(model.deviceId);
                          },
                        },
                      ]
                    : [
                        ...profiles.map((profile) => ({
                          label: holder?.id === profile.id
                            ? t("mouse.slotCtxAssigned", { name: profile.name })
                            : t("mouse.slotCtxAssign", { name: profile.name }),
                          disabled: holder?.id === profile.id || slotActionBusy || flushState === "busy",
                          onClick: () => assignProfileToSlot(model.deviceId, slot, profile.id),
                        })),
                        ...(holder
                          ? [
                              null,
                              ...(!isDedicated
                                ? [
                                    {
                                      label: t("mouse.makeOfflineSlot"),
                                      onClick: () => {
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
                                      },
                                    },
                                    {
                                      label: directOn ? t("mouse.slotCtxDirectOff") : t("mouse.slotCtxDirectOn"),
                                      onClick: () => {
                                        setFlushState("idle");
                                        updateDraft((config) => setProfileMouse(config, holder.id, model.deviceId, { hardwareBank: !directOn }), { immediate: true });
                                      },
                                    },
                                  ]
                                : []),
                              ...(onOpenProfileButtons
                                ? [{
                                    label: t("mouse.slotCtxOpenButtons", { name: holder.name }),
                                    onClick: () => onOpenProfileButtons(holder.id),
                                  }]
                                : []),
                            ]
                          : []),
                        ...(isAssigned && canDeleteSlot
                          ? [
                              null,
                              {
                                label: holder ? t("mouse.slotDelete") : t("mouse.slotClearUnlinked"),
                                danger: true,
                                disabled: slotActionBusy || flushState === "busy",
                                onClick: () => handleDeleteSlot(model.deviceId, slot, holder?.id, true),
                              },
                            ]
                          : []),
                      ];
                  return (
                    <ContextMenu
                      x={slotCtxMenu.x}
                      y={slotCtxMenu.y}
                      onClose={() => setSlotCtxMenu(null)}
                      items={items}
                    />
                  );
                })() : null}
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
