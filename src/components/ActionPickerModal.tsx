import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Layer, MouseActionKind } from "../lib/config";
import { isOfflineLayer, MAX_SEQUENCE_STEPS, NATIVE_HYPERSHIFT_TRIGGERS, type HypershiftTrigger } from "../lib/config";
import { displayNameForControlId, labelForLayer, offlineAssignmentLabel } from "../lib/labels";
import { ACTION_CATEGORIES, MOUSE_ACTION_OPTIONS } from "../lib/constants";
import { classifyHardwarePlayability, isBuiltinControl, isKeyButton, type OfflineControl } from "../lib/onboard-mapping";
import { canBeHypershift2Trigger, controlLayout, hypershift2ControlId, layoutControlId, setHypershift2Trigger } from "../lib/devices";
import { getNativeModel, listNativeMice, liveTestAction, listenEncodedKeyEvent, normalizeCommandError } from "../lib/backend";
import { uiText } from "../lib/ui-text";
import { PillTrack } from "./PillTrack";
import {
  expectedEncodedKeyForControl,
  ensurePlaceholderBinding,
  findBinding,
  GESTURES,
  type Gesture,
  isPlaceholderAction,
  nextUniqueId,
  removeBinding,
  setOfflineAssignment,
  promoteInlineSnippetActionToLibrary,
  upsertAction,
  upsertSnippetLibraryItem,
  upsertBinding,
  upsertEncoderMapping,
} from "../lib/config-editing";
import { MenuItemsEditor } from "./MenuItemsEditor";
import { CategoryIcon, ChevronIcon } from "./icons";
import { GestureIcon } from "./mouse-visual/GestureIcon";
import { applyMenuEdits, isMenuIncomplete, NO_MENU_EDITS, type MenuEdits } from "../lib/menu-phrase";
import { bindingUses, otherMenuUses } from "../lib/menu-arrange";
import { snippetPlaceCounts } from "../lib/snippet-search";
import { CloseButton, HelpTip, ModalFooter, ModalShell, Notice, SelectField, Toggle } from "./shared";
import { createDraftHistoryStore, type DraftHistoryStore, historyKey, useDraftHistory } from "../hooks/useDraftHistory";
import { ConfirmModal } from "./ConfirmModal";
import { copySlotToOtherMice, slotKey, slotReplacements, slotSynced, withSlotSync } from "../lib/device-transfer";
import { gestureOf } from "../lib/config-editing";
import { deviceLayout } from "../lib/devices";
import {
  autoName,
  buildAction,
  createInitialDrafts,
  describeAction,
  isSaveDisabled,
  isOfflinePayloadPlayable,
  OFFLINE_MOUSE_ACTION_OPTIONS,
  type PickerDrafts,
  enterPhraseOf,
} from "../lib/action-picker-helpers";
import type { TriggerMode } from "../lib/config";
import { SequenceStepEditor } from "./action-picker/SequenceStepEditor";
import { ShortcutEditor } from "./action-picker/ShortcutEditor";
import { MouseActionEditor } from "./action-picker/MouseActionEditor";
import { TextSnippetEditor } from "./action-picker/TextSnippetEditor";
import { LaunchEditor } from "./action-picker/LaunchEditor";
import { MediaKeyEditor } from "./action-picker/MediaKeyEditor";
import { ProfileSwitchEditor } from "./action-picker/ProfileSwitchEditor";
import { SignalCaptureField } from "./action-picker/SignalCaptureField";
import { ConditionsEditor } from "./action-picker/ConditionsEditor";
import { TriggerModeEditor } from "./action-picker/TriggerModeEditor";

/* ─────────────────────────────────────────────────────────
   Action Picker Modal
   ───────────────────────────────────────────────────────── */

const LAST_PICKER_CATEGORY_KEY = "sidearm:lastPickerCategory";
const LEGACY_LAST_PICKER_CATEGORY_KEY = "naga-studio:lastPickerCategory";

const TRIGGER_LABEL_KEYS: Record<TriggerMode, string> = {
  press: "picker.triggerPress",
  doublePress: "picker.triggerDoublePress",
  triplePress: "picker.triggerTriplePress",
  hold: "picker.triggerHold",
  chord: "picker.triggerChord",
  longPress: "picker.triggerLongPress",
};

const GESTURE_LABEL_KEYS: Record<Gesture, string> = {
  press: "picker.gesturePress",
  longPress: "picker.gestureLongPress",
  doublePress: "picker.gestureDoublePress",
  triplePress: "picker.gestureTriplePress",
};

/** Everything the picker's undo history holds: the drafts, the tab they belong
 *  to and the config as it was there (a tab switch applies the tab's edit). */
interface PickerSnapshot {
  gesture: Gesture;
  layer: Layer | undefined;
  offlineChoice: "silent" | null | undefined;
  /** "The same on <mouse>" and "Also save to the library": undone with the drafts. */
  syncDraft: boolean;
  saveToLibraryDraft: boolean;
  base: AppConfig;
  activeCategory: string;
  shortcutDraft: PickerDrafts["shortcut"];
  mouseDraft: PickerDrafts["mouse"];
  textDraft: PickerDrafts["text"];
  launchDraft: PickerDrafts["launch"];
  mediaDraft: PickerDrafts["media"];
  profileDraft: PickerDrafts["profile"];
  sequenceDraft: PickerDrafts["sequence"];
  nameDraft: string;
  triggerModeDraft: TriggerMode;
  chordPartnerDraft: string;
  throttleDraft: number;
  conditionsDraft: PickerDrafts["conditions"];
  menuItemsDraft: PickerDrafts["menuItems"];
  cheatLayerDraft: Layer;
  menuEdits: MenuEdits;
  signalDraft: string | null;
}

interface ActionPickerProps {
  offlineControl?: OfflineControl;
  config: AppConfig;
  bindingId: string | null;
  profileId?: string;
  controlLabel?: string;
  layerLabel?: string;
  controlId?: ControlId;
  selectedLayer?: Layer;
  /** Which press pattern of the control this edits (its own binding). */
  gesture?: Gesture;
  /** A menu item to select in the menu editor on open. */
  focusMenuItemId?: string;
  /** Shows the press-pattern tabs; picking one edits that pattern's binding. */
  onGestureChange?: (gesture: Gesture) => void;
  /** Applies a tab's edit without closing (on a tab switch). */
  onApply?: (config: AppConfig) => void;
  onSave: (config: AppConfig) => void;
  onCancel: () => void;
}

/** Each press-pattern tab is its own mount (its drafts come from that
 *  pattern's binding); the undo history is one for the whole picker, so
 *  Ctrl+Z after a tab switch goes back into the tab before. */
export function ActionPickerModal(props: ActionPickerProps) {
  return <ActionPicker key={`${props.profileId}:${props.selectedLayer}:${props.controlId}`} {...props} />;
}

function ActionPicker(props: ActionPickerProps) {
  const { t } = useTranslation();
  const [store] = useState(createDraftHistoryStore<PickerSnapshot>);
  // Drafts an undo / redo brings back onto another tab, read by that tab's mount.
  const [seed, setSeed] = useState<PickerSnapshot | null>(null);
  const [layer, setLayer] = useState(props.selectedLayer);
  const gesture = layer && isOfflineLayer(layer) ? "press" : props.gesture ?? "press";
  // Applying the live edit invalidates its preview. Seed the offline tab only
  // from the fresh result, while keeping the history store above the tab.
  if (layer !== props.selectedLayer && layer && isOfflineLayer(layer) && !props.offlineControl) {
    return <ModalShell onClose={props.onCancel} className="modal action-picker" ariaLabel={t("picker.title")}>
      <p className="action-picker__preview panel__muted">{t("offline.loading")}</p>
    </ModalShell>;
  }
  return <PickerTab key={`${layer}:${gesture}`} {...props} selectedLayer={layer}
    layerLabel={layer !== props.selectedLayer && layer ? labelForLayer(layer) : props.layerLabel}
    gesture={gesture} store={store} seed={seed} onSeed={setSeed} onLayerChange={setLayer} />;
}

function PickerTab({
  offlineControl,
  config,
  bindingId,
  profileId,
  controlLabel,
  layerLabel,
  controlId,
  selectedLayer,
  gesture = "press",
  onGestureChange,
  onApply,
  onSave,
  onCancel,
  focusMenuItemId,
  store,
  seed,
  onSeed,
  onLayerChange,
}: ActionPickerProps & {
  store: DraftHistoryStore<PickerSnapshot>;
  seed: PickerSnapshot | null;
  onSeed: (seed: PickerSnapshot | null) => void;
  onLayerChange: (layer: Layer | undefined) => void;
}) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save previously focused element and restore on unmount
  useEffect(() => {
    mountedRef.current = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      mountedRef.current = false;
      if (testTimerRef.current !== null) clearTimeout(testTimerRef.current);
      previousFocusRef.current?.focus();
    };
  }, []);

  // Auto-focus the search input on mount (falling back to any interactive
  // element). Plain DOM order used to land on the close button, opening the
  // modal with a focus ring on the ✕.
  useEffect(() => {
    const container = modalRef.current;
    if (!container) return;
    const firstFocusable =
      container.querySelector<HTMLElement>('input[type="text"], input:not([type]), textarea') ??
      container.querySelector<HTMLElement>(
        'input, button, select, [tabindex]:not([tabindex="-1"])',
      );
    firstFocusable?.focus();
  }, []);


  const offline = selectedLayer !== undefined && isOfflineLayer(selectedLayer);
  const binding = offline && profileId && controlId && selectedLayer ? findBinding(config, profileId, selectedLayer, controlId) ?? null
    : bindingId ? config.bindings.find((b) => b.id === bindingId) ?? null : null;
  const savedAction = binding
    ? config.actions.find((a) => a.id === binding.actionId) ?? null
    : null;
  const existingAction = offline ? (offlineControl?.kind === "own" || offlineControl?.kind === "inherited")
    ? config.actions.find((action) => action.id === offlineControl.actionId) ?? null : null
    : isPlaceholderAction(savedAction) ? null : savedAction;
  // Where else this action runs: other buttons and menu items (shown under the preview).
  const elsewhere = existingAction
    ? [...bindingUses(config, existingAction.id, binding), ...otherMenuUses(config, NO_MENU_EDITS, existingAction.id, existingAction.id)]
    : [];
  // Other buttons using this very action (one menu for both mice, say).
  const sharedUses = existingAction && binding
    ? config.bindings.filter((b) => b.actionId === existingAction.id && b.id !== binding.id).length
    : 0;

  // Encoder signal state (user devices only — see isBuiltinControl)
  const builtinControl = controlId ? isBuiltinControl(config, controlId) : false;
  const layout = controlId ? controlLayout(config, controlId) : undefined;
  // A firmware trigger is fixed in the mouse; only the software one can move.
  const softwareTrigger = !offline && builtinControl && !layout?.firmwareTrigger;
  const currentTrigger = softwareTrigger ? config.settings.hypershiftTrigger ?? "mouse_right" : "none";
  // The role sits on the plain press (the button never clicks) or on the
  // held press (a quick press still clicks: `hypershiftTap`).
  const roleTab: Gesture = config.settings.hypershiftTap ? "longPress" : "press";
  const isCurrentTrigger = softwareTrigger && controlId === currentTrigger && gesture === roleTab;
  const canBeTrigger = softwareTrigger && NATIVE_HYPERSHIFT_TRIGGERS.some((id) => id === controlId);
  // HyperShift 2 is per profile and only a held press (a quick press clicks).
  const canBeTrigger2 = !offline && !!controlId && !!profileId && canBeHypershift2Trigger(config, controlId);
  const isCurrentTrigger2 = canBeTrigger2 && gesture === "longPress"
    && hypershift2ControlId(config, profileId, layout?.deviceId) === controlId;
  // An unverified Naga keeps HyperShift in Sidearm's own trigger: the same
  // button cannot also be HyperShift 2 then (the backend drops it).
  const [softwareTriggerMouse, setSoftwareTriggerMouse] = useState(false);
  useEffect(() => {
    if (!canBeTrigger2) return;
    void listNativeMice().then((mice) => setSoftwareTriggerMouse(mice.some((mouse) => !mouse.verified)), () => {});
  }, [canBeTrigger2]);
  const hypershift2Conflict = canBeTrigger2 && softwareTriggerMouse && !!controlId
    && (config.settings.hypershiftTrigger ?? "mouse_right") === layoutControlId(controlId);
  // A global modifier role is not an executable, profile-specific ActionType.
  const inheritCategory = { id: "native", icon: "↺", label: "picker.offlineInherit", actionType: "native" };
  const categories = offline ? ACTION_CATEGORIES.filter((category) =>
    category.id === "shortcut" || category.id === "mouseAction" || category.id === "disabled")
    .map((category) => category.id === "disabled" ? { ...category, label: "picker.offlineSilent" } : category) : [
    { id: "native", icon: "↺", label: "picker.native", actionType: "native" },
    ...(canBeTrigger && (gesture === "press" || gesture === "longPress") ? [{ id: "hypershift", icon: "HS", label: "picker.hypershift", actionType: "hypershift" }] : []),
    ...(canBeTrigger2 && gesture === "longPress" ? [{ id: "hypershift2", icon: "H2", label: "picker.hypershift2", actionType: "hypershift2" }] : []),
    ...ACTION_CATEGORIES,
  ];
  // The mouse reports one key button at a time only with consumer signals; in
  // F13..F24 mode two arrive together. Asked once per opened key button.
  const keyButton = !offline && builtinControl && controlId !== undefined && isKeyButton(layoutControlId(controlId));
  const [consumerSignals, setConsumerSignals] = useState(false);
  useEffect(() => {
    if (!keyButton) return;
    void getNativeModel(layout?.deviceId).then(
      (model) => setConsumerSignals(model.consumerSignals === true),
      () => setConsumerSignals(false),
    );
  }, [keyButton, layout?.deviceId]);
  const currentEncoderMapping = controlId && selectedLayer
    ? config.encoderMappings.find(
        (m) => m.controlId === controlId && m.layer === selectedLayer,
      ) ?? null
    : null;
  const expectedSignal = controlId && selectedLayer
    ? expectedEncodedKeyForControl(controlId, selectedLayer)
    : null;

  // Draft action state per category — seeded once from the edited action/binding
  // (`pristine`), or from the step an undo / redo brought back onto this tab.
  // "The same on the other mouse": this button's edits repeated on the same
  // place of the other built-in mice (settings.syncSlots over syncMice).
  const ownDevice = controlId ? config.physicalControls.find((control) => control.id === controlId)?.deviceId : undefined;
  const otherMice = ownDevice && deviceLayout(ownDevice)
    ? config.devices.filter((device) => device.builtin && device.id !== ownDevice && deviceLayout(device.id))
    : [];
  const syncKey = otherMice.length > 0 && profileId && selectedLayer && controlId ? slotKey(profileId, selectedLayer, gesture, controlId) : null;
  const [pristine] = useState((): PickerSnapshot => {
    const initial = createInitialDrafts(existingAction, binding, config.profiles, config.snippetLibrary);
    const offlineNative = offline && !existingAction && offlineControl?.native
      ? (offlineControl.native as MouseActionKind)
      : null;
    const offlineCategory = existingAction?.type
      ?? (offlineNative ? "mouseAction" : offlineControl?.kind === "preserved" ? "shortcut" : "disabled");
    return {
      gesture,
      layer: selectedLayer,
      offlineChoice: undefined,
      syncDraft: syncKey ? slotSynced(config.settings, syncKey) : false,
      // Default ON so snippet text lands in the durable library, not only inline on
      // the button — inline-only text is silently lost when the button is later
      // reassigned. Snippets already backed by the library don't need re-saving.
      saveToLibraryDraft: !(existingAction?.type === "textSnippet" && existingAction.payload.source === "libraryRef"),
      base: config,
      activeCategory: offline ? offlineCategory
        : isCurrentTrigger ? "hypershift"
        : isCurrentTrigger2 ? "hypershift2"
        : !existingAction ? "native"
        : enterPhraseOf(existingAction, config.snippetLibrary) !== null ? "textSnippet"
        : ACTION_CATEGORIES.find((c) => c.actionType === existingAction.type)?.id ?? "shortcut",
      shortcutDraft: initial.shortcut,
      mouseDraft: offlineNative
        ? { action: offlineNative, ctrl: false, shift: false, alt: false, win: false }
        : initial.mouse,
      textDraft: initial.text,
      launchDraft: initial.launch,
      mediaDraft: initial.media,
      profileDraft: initial.profile,
      sequenceDraft: initial.sequence,
      nameDraft: isPlaceholderAction(existingAction) ? "" : initial.name,
      triggerModeDraft: initial.triggerMode,
      chordPartnerDraft: initial.chordPartner,
      throttleDraft: initial.throttleMs,
      conditionsDraft: initial.conditions,
      menuItemsDraft: initial.menuItems,
      cheatLayerDraft: initial.cheatLayer ?? "hypershift",
      menuEdits: NO_MENU_EDITS,
      signalDraft: currentEncoderMapping?.encodedKey ?? null,
    };
  });
  const start = seed ?? pristine;
  const [offlineChoice, setOfflineChoice] = useState(start.offlineChoice);

  const [signalDraft, setSignalDraft] = useState(start.signalDraft);
  const [isCapturingSignal, setIsCapturingSignal] = useState(false);

  const [activeCategory, setActiveCategory] = useState(start.activeCategory);

  function setActiveCategoryWithMemory(cat: string) {
    setActiveCategory(cat);
    setNameDraft("");
    localStorage.setItem(LAST_PICKER_CATEGORY_KEY, cat);
    localStorage.removeItem(LEGACY_LAST_PICKER_CATEGORY_KEY);
  }
  const [searchQuery, setSearchQuery] = useState("");

  const query = searchQuery.trim().toLowerCase();
  const filteredCategories = categories.filter((cat) =>
    !query || [cat.id, cat.actionType, t(cat.label),
      ...(cat.actionType === "mouseAction" ? (offline ? OFFLINE_MOUSE_ACTION_OPTIONS : MOUSE_ACTION_OPTIONS).flatMap((item) => [item.value, t(item.label)]) : []),
    ].some((text) => text.toLowerCase().includes(query)),
  );

  const effectiveCategory = (offline && activeCategory === "native") || filteredCategories.some((c) => c.id === activeCategory)
    ? activeCategory
    : filteredCategories[0]?.id ?? "shortcut";

  const [isCapturing, setIsCapturing] = useState(false);

  const [shortcutDraft, setShortcutDraft] = useState(start.shortcutDraft);
  const [mouseDraft, setMouseDraft] = useState(start.mouseDraft);
  const [textDraft, setTextDraft] = useState(start.textDraft);
  const [saveSnippetToLibrary, setSaveSnippetToLibrary] = useState(start.saveToLibraryDraft);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [launchDraft, setLaunchDraft] = useState(start.launchDraft);
  const [mediaDraft, setMediaDraft] = useState(start.mediaDraft);
  const [profileDraft, setProfileDraft] = useState(start.profileDraft);
  const [sequenceDraft, setSequenceDraft] = useState(start.sequenceDraft);
  const [nameDraft, setNameDraft] = useState(start.nameDraft);
  const [triggerModeDraft, setTriggerModeDraft] = useState(start.triggerModeDraft);
  const [chordPartnerDraft, setChordPartnerDraft] = useState(start.chordPartnerDraft);
  const [throttleDraft, setThrottleDraft] = useState(start.throttleDraft);
  const [conditionsDraft, setConditionsDraft] = useState(start.conditionsDraft);
  const [menuItemsDraft, setMenuItemsDraft] = useState(start.menuItemsDraft);
  const [cheatLayerDraft, setCheatLayerDraft] = useState(start.cheatLayerDraft);

  // Advanced settings (trigger mode, throttle, conditions) collapse by default,
  // but open automatically when the edited action already has any of them set.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => start.triggerModeDraft !== "press" || start.throttleDraft > 0 || start.conditionsDraft.length > 0,
  );

  // Phrase texts and new phrase actions edited in the menu editor, written on Save.
  const [menuEdits, setMenuEdits] = useState(start.menuEdits);

  // Signal capture: listen to runtime's encoded_key_received event
  useEffect(() => {
    if (!isCapturingSignal) return;

    let cancelled = false;

    const unlistenPromise = listenEncodedKeyEvent("encoded_key_received", (event) => {
      if (cancelled) return;
      setSignalDraft(event.encodedKey);
      setIsCapturingSignal(false);
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [isCapturingSignal]);

  const drafts: PickerDrafts = {
    shortcut: shortcutDraft,
    mouse: mouseDraft,
    text: textDraft,
    launch: launchDraft,
    media: mediaDraft,
    profile: profileDraft,
    sequence: sequenceDraft,
    menuItems: menuItemsDraft,
    cheatLayer: cheatLayerDraft,
    name: nameDraft,
    conditions: conditionsDraft,
  };

  /** The config with this tab's edit in it; null when it cannot be saved. */
  function buildSave(): AppConfig | null {
    if (saveDisabled) return null;
    if (selectedLayer && isOfflineLayer(selectedLayer)) {
      if (!profileId || !controlId) return null;
      const untouchedOfflineNative = !binding
        && Boolean(offlineControl?.native)
        && effectiveCategory === "mouseAction"
        && mouseDraft.action === offlineControl?.native
        && !mouseDraft.ctrl && !mouseDraft.shift && !mouseDraft.alt && !mouseDraft.win;
      if (untouchedOfflineNative) return config;
      const payload = effectiveCategory === "native" ? null
        : effectiveCategory === "disabled" ? "silent"
        : effectiveCategory === "shortcut" ? shortcutDraft : mouseDraft;
      return setOfflineAssignment(config, profileId, controlId, selectedLayer, payload);
    }
    if (effectiveCategory === "hypershift") {
      if (!canBeTrigger || !controlId) return null;
      return {
        ...config,
        settings: { ...config.settings, hypershiftTrigger: controlId as HypershiftTrigger, hypershiftTap: gesture === "longPress" },
      };
    }
    if (effectiveCategory === "hypershift2") {
      if (!canBeTrigger2 || !controlId || !profileId) return null;
      return setHypershift2Trigger(config, profileId, controlId, true);
    }
    let nextConfig = isCurrentTrigger
      ? { ...config, settings: { ...config.settings, hypershiftTrigger: "none" as const } }
      : config;
    if (isCurrentTrigger2 && controlId && profileId) {
      nextConfig = setHypershift2Trigger(nextConfig, profileId, controlId, false);
    }
    if (effectiveCategory === "native") {
      return binding ? removeBinding(nextConfig, binding.id) : nextConfig;
    }
    let targetBinding = binding;
    if (!targetBinding) {
      const control = config.physicalControls.find((c) => c.id === controlId);
      if (!control || !profileId || !selectedLayer) return null;
      const result = ensurePlaceholderBinding(nextConfig, profileId, selectedLayer, control, gesture);
      nextConfig = result.config;
      targetBinding = nextConfig.bindings.find((b) => b.id === result.bindingId) ?? null;
    }
    if (!targetBinding) return null;
    const nextAction = buildAction({ effectiveCategory, existingAction, drafts, t, profiles: config.profiles });
    // An action other buttons or menus use is edited for this button alone, except a
    // shared menu edited as a menu: keeping it one menu is why it is shared.
    if (existingAction && (sharedUses > 0 || elsewhere.length > 0) && !(existingAction.type === "menu" && nextAction.type === "menu")) {
      nextAction.id = nextUniqueId(config.actions.map((a) => a.id), existingAction.id);
    }
    // Reuse the new slot's action id so Save cannot leave an orphan placeholder.
    if (!existingAction) {
      nextAction.id = !binding && config.actions.some((a) => a.id === targetBinding.actionId)
        ? nextUniqueId(config.actions.map((a) => a.id), targetBinding.actionId)
        : targetBinding.actionId;
    }
    nextConfig = upsertAction(nextConfig, nextAction);
    if (effectiveCategory === "menu") nextConfig = applyMenuEdits(nextConfig, menuEdits, menuItemsDraft);
    // A library text edited here is the library's: every use gets it (as in the menu editor).
    const linkedSnippet = effectiveCategory === "textSnippet" && textDraft.snippetId
      ? nextConfig.snippetLibrary.find((snippet) => snippet.id === textDraft.snippetId)
      : undefined;
    if (linkedSnippet && (linkedSnippet.text !== textDraft.text || linkedSnippet.pasteMode !== textDraft.pasteMode)) {
      // A blanked text is not written: it would blank every use (the button still
      // saves — renamed, another trigger — against the library's own text).
      nextConfig = upsertSnippetLibraryItem(nextConfig, { ...linkedSnippet, text: textDraft.text.trim() ? textDraft.text : linkedSnippet.text, pasteMode: textDraft.pasteMode });
    }

    // Opt-in: store this inline snippet in the reusable library AND link the
    // button to it (source: libraryRef), so later library edits reach the
    // button. Promote mints a unique snippet id, so same-named snippets no
    // longer clobber each other. A snippet picked from the library is already a
    // libraryRef (textDraft.snippetId set), so skip — nothing to promote.
    if (
      saveSnippetToLibrary &&
      effectiveCategory === "textSnippet" &&
      !textDraft.snippetId &&
      textDraft.text.trim()
    ) {
      const snippetName = nameDraft.trim() || nextAction.displayName || textDraft.text.trim().slice(0, 30);
      nextConfig = promoteInlineSnippetActionToLibrary(nextConfig, nextAction.id, snippetName);
    }

    if (targetBinding) {
      nextConfig = upsertBinding(nextConfig, {
        ...targetBinding,
        actionId: nextAction.id,
        label: nextAction.displayName,
        // Preserve enabled state only when editing a REAL saved action; a
        // first-time assignment sits on a disabled placeholder action+binding
        // (enabled:false), so treat placeholder as "new" and enable it.
        enabled: existingAction ? targetBinding.enabled : true,
        triggerMode: gesture !== "press" ? gesture : triggerModeDraft === "press" ? undefined : triggerModeDraft,
        chordPartner: triggerModeDraft === "chord" && chordPartnerDraft
          ? chordPartnerDraft as ControlId
          : undefined,
        throttleMs: throttleDraft > 0 ? throttleDraft : undefined,
      });
    }

    // Save encoder mapping if signal was set/changed. Never for the built-in
    // Naga: its signals are the codes Sidearm writes into the mouse.
    if (controlId && selectedLayer && !builtinControl && signalDraft && signalDraft !== currentEncoderMapping?.encodedKey) {
      nextConfig = upsertEncoderMapping(nextConfig, {
        controlId,
        layer: selectedLayer,
        encodedKey: signalDraft,
        source: "detected",
        verified: false,
      });
    }

    return nextConfig;
  }

  const [syncDraft, setSyncDraft] = useState(start.syncDraft);

  /** The save with the sync choice applied; turned on, the button is copied
   *  onto the other mice at once. */
  function withSync(next: AppConfig | null): AppConfig | null {
    if (next && !offline && offlineChoice !== undefined && offlineControl?.editable && profileId && controlId) {
      next = setOfflineAssignment(next, profileId, controlId, offlineControl.layer, offlineChoice);
    }
    if (!next || !syncKey || syncDraft === slotSynced(config.settings, syncKey)) return next;
    const synced = withSlotSync(next, syncKey, syncDraft);
    const own = ownBinding(synced);
    return syncDraft && own ? copySlotToOtherMice(synced, own.id) : synced;
  }

  /** This button's binding (this tab's press pattern) in `next`. */
  function ownBinding(next: AppConfig) {
    return next.bindings.find((binding) => binding.profileId === profileId && binding.layer === selectedLayer
      && binding.controlId === controlId && gestureOf(binding.triggerMode) === gesture);
  }

  function handleSave() {
    const next = withSync(buildSave());
    if (next) onSave(next);
  }

  /** Another press pattern's tab: this tab's edit is kept (applied without
   *  closing), so several patterns can be set in one go. */
  function switchGesture(next: Gesture) {
    if (next === gesture || !onGestureChange) return;
    const saved = saveDisabled ? null : withSync(buildSave());
    if (saved && saved !== config) onApply?.(saved);
    onSeed(null);
    onGestureChange(next);
  }

  function switchToOffline() {
    if (!offlineControl?.editable || saveDisabled) return;
    const saved = withSync(buildSave());
    if (saved && saved !== config) onApply?.(saved);
    onSeed(null);
    onLayerChange(offlineControl.layer);
  }

  async function handleTest() {
    if (offline || testRunning || saveDisabled) return;
    const draftAction = buildAction({ effectiveCategory, existingAction, drafts, t, profiles: config.profiles });
    setTestRunning(true);
    try {
      // Launch/URL/folder don't depend on focus — run immediately. Input
      // actions (keys, text, media, macro) go to the focused window, so count
      // down to let the user switch to their target window first.
      if (effectiveCategory !== "launch") {
        for (let n = 3; n > 0; n -= 1) {
          setTestResult({ ok: true, text: t("picker.testCountdown", { n }) });
          await new Promise<void>((resolve) => { testTimerRef.current = setTimeout(resolve, 1000); });
          testTimerRef.current = null;
          if (!mountedRef.current) return;
        }
      }
      const result = await liveTestAction(draftAction, profileId ?? binding?.profileId);
      if (!mountedRef.current) return;
      const detail =
        result.warnings.length > 0
          ? `${uiText(result.summary)} — ${result.warnings.map(uiText).join("; ")}`
          : uiText(result.summary);
      setTestResult({ ok: true, text: detail });
    } catch (error) {
      if (mountedRef.current) setTestResult({ ok: false, text: normalizeCommandError(error).message });
    } finally {
      if (mountedRef.current) setTestRunning(false);
    }
  }

  const roleCategory = effectiveCategory === "native" || effectiveCategory === "hypershift" || effectiveCategory === "hypershift2";
  const offlineUnplayable = offline && ((effectiveCategory === "shortcut" && !isOfflinePayloadPlayable(shortcutDraft))
    || (effectiveCategory === "mouseAction" && !isOfflinePayloadPlayable(mouseDraft)));
  const offlineBlocked = offline && !offlineControl?.editable && !(effectiveCategory === "native" && binding);
  const saveDisabled = offlineBlocked || (roleCategory
    ? false
    : offlineUnplayable || isSaveDisabled(effectiveCategory, drafts)
      || (effectiveCategory === "sequence" && (sequenceDraft.length === 0 || sequenceDraft.length > MAX_SEQUENCE_STEPS
        || sequenceDraft.some((step) => (step.type === "waitWindow" && !step.exe.trim()) || (step.type === "send" && !step.value.trim()))))
      || (effectiveCategory === "menu" && isMenuIncomplete(config, menuEdits, menuItemsDraft)));
  // Turning "The same on" on overwrites the other mice's button: say what it holds.
  const syncSave = syncKey && syncDraft && !slotSynced(config.settings, syncKey) ? buildSave() : null;
  const syncOwn = syncSave ? ownBinding(syncSave) : undefined;
  const syncReplaced = syncSave && syncOwn
    ? slotReplacements(syncSave, syncOwn.id).map((other) => ({
        id: other.id,
        action: syncSave.actions.find((action) => action.id === other.actionId)?.displayName || other.label,
        mouse: config.devices.find((device) => device.id === config.physicalControls.find((c) => c.id === other.controlId)?.deviceId)?.name ?? "",
      }))
    : [];
  const activeConditionsCount = conditionsDraft.filter((c) => c.value.trim()).length;
  const advancedTags = [
    triggerModeDraft !== "press" ? t(TRIGGER_LABEL_KEYS[triggerModeDraft]) : null,
    throttleDraft > 0 ? t("picker.advancedThrottleTag", { ms: throttleDraft }) : null,
    activeConditionsCount > 0 ? t("picker.advancedConditionsTag", { count: activeConditionsCount }) : null,
  ].filter(Boolean);
  const advancedSummary = advancedTags.length > 0 ? advancedTags.join(" · ") : t("picker.advancedDefaults");
  const previewText = offline && effectiveCategory === "native" ? t("picker.offlineInherit")
    : offline && effectiveCategory === "disabled" ? t("picker.offlineSilentHint") : roleCategory
    ? t(effectiveCategory === "hypershift" ? "picker.hypershiftPreview"
      : effectiveCategory === "hypershift2" ? "picker.hypershift2Preview" : "picker.nativePreview")
    : describeAction(effectiveCategory, drafts, t, config.profiles);
  const hardwareStatus = !offline && builtinControl && !roleCategory && selectedLayer && controlId && profileId
    ? (() => {
        const draftAction = buildAction({ effectiveCategory, existingAction, drafts, t, profiles: config.profiles });
        const draftBinding = {
          id: binding?.id ?? "__draft__",
          profileId,
          layer: selectedLayer,
          controlId,
          label: "",
          actionId: draftAction.id,
          enabled: true,
          triggerMode: gesture === "press" ? triggerModeDraft : gesture,
        };
        return classifyHardwarePlayability(config, profileId, selectedLayer, controlId, draftBinding, draftAction, {
          checkHs2: Boolean(layout?.hypershift2Triggers?.length),
        });
      })()
    : null;
  const hardwareReason = hardwareStatus?.reason
    ? hardwareStatus.reason === "actionType"
      ? t("offline.reason.actionType", { type: t(`action.type.${hardwareStatus.actionType ?? "disabled"}`) })
      : t(`offline.reason.${hardwareStatus.reason}`)
    : null;
  const offlineSummary = offlineChoice === "silent" ? t("offline.silent")
    : offlineChoice === null ? t("offline.inherit")
    : offlineAssignmentLabel(offlineControl ?? { kind: "unknown", editable: false },
      config.actions.find((action) => action.id === offlineControl?.actionId) ?? null);
  const activeCat = offline && effectiveCategory === "native" ? inheritCategory : categories.find((c) => c.id === effectiveCategory);
  const categoryDescription = offline && effectiveCategory === "native" ? "picker.offlineInheritHint"
    : offline && effectiveCategory === "disabled" ? "picker.offlineSilentHint"
    : offline && effectiveCategory === "mouseAction" ? "picker.offlineMouseHint" : `picker.categoryDesc.${effectiveCategory}`;

  // Undo / redo of every edit made in the picker before Save (a menu item moved
  // into the wrong list, a step deleted…), across the press-pattern tabs.
  const current: PickerSnapshot = {
    gesture, layer: selectedLayer, offlineChoice, base: config, syncDraft, saveToLibraryDraft: saveSnippetToLibrary,
    activeCategory, shortcutDraft, mouseDraft, textDraft, launchDraft, mediaDraft, profileDraft, sequenceDraft,
    nameDraft, triggerModeDraft, chordPartnerDraft, throttleDraft, conditionsDraft, menuItemsDraft, cheatLayerDraft,
    menuEdits, signalDraft,
  };
  const history = useDraftHistory(
    current,
    (snapshot) => {
      if (snapshot.layer !== selectedLayer || (snapshot.gesture !== gesture && onGestureChange)) {
        // A step of another tab: the config as it was there (that tab's applied
        // edit taken back), then that tab with these drafts.
        onSeed(snapshot);
        if (snapshot.base !== config) onApply?.(snapshot.base);
        onLayerChange(snapshot.layer);
        if (snapshot.gesture !== gesture) onGestureChange?.(snapshot.gesture);
        return;
      }
      setActiveCategory(snapshot.activeCategory);
      setOfflineChoice(snapshot.offlineChoice);
      setShortcutDraft(snapshot.shortcutDraft);
      setMouseDraft(snapshot.mouseDraft);
      setTextDraft(snapshot.textDraft);
      setLaunchDraft(snapshot.launchDraft);
      setMediaDraft(snapshot.mediaDraft);
      setProfileDraft(snapshot.profileDraft);
      setSequenceDraft(snapshot.sequenceDraft);
      setNameDraft(snapshot.nameDraft);
      setTriggerModeDraft(snapshot.triggerModeDraft);
      setChordPartnerDraft(snapshot.chordPartnerDraft);
      setThrottleDraft(snapshot.throttleDraft);
      setConditionsDraft(snapshot.conditionsDraft);
      setMenuItemsDraft(snapshot.menuItemsDraft);
      setCheatLayerDraft(snapshot.cheatLayerDraft);
      setMenuEdits(snapshot.menuEdits);
      setSignalDraft(snapshot.signalDraft);
      setSyncDraft(snapshot.syncDraft);
      setSaveSnippetToLibrary(snapshot.saveToLibraryDraft);
    },
    { store, passive: ["base"] },
  );

  // Esc, ✕, Cancel and a click outside: edits of this tab are not dropped
  // without asking (a tab switch has already applied the tabs before).
  const [askDiscard, setAskDiscard] = useState(false);
  function requestClose() {
    const edited = (Object.keys(pristine) as Array<keyof PickerSnapshot>).some((key) =>
      key !== "base" && key !== "gesture" && JSON.stringify(pristine[key]) !== JSON.stringify(current[key]));
    if (edited) setAskDiscard(true); else onCancel();
  }

  const liveActionForOffline = offline && profileId && controlId && selectedLayer
    ? (() => {
        const liveLayer = selectedLayer === "offlineHypershift" ? "hypershift" : "standard";
        const liveBinding = findBinding(config, profileId, liveLayer, controlId)
          ?? (liveLayer === "hypershift" ? findBinding(config, profileId, "standard", controlId) : undefined);
        const liveAction = liveBinding?.enabled ? config.actions.find((a) => a.id === liveBinding.actionId) : undefined;
        return liveAction && !isPlaceholderAction(liveAction) ? liveAction : null;
      })()
    : null;
  const offlineLiveLabel = liveActionForOffline
    ? liveActionForOffline.displayName || t(`action.type.${liveActionForOffline.type}`)
    : null;

  return (
    <>
    <ModalShell
      onClose={requestClose}
      className={`modal action-picker${effectiveCategory === "menu" ? " action-picker--tall" : ""}`}
      dialogRef={modalRef}
      ariaLabelledby="action-picker-title"
      escapeEnabled={!isCapturing && !isCapturingSignal && !askDiscard}
      onKeyDown={(e) => {
        // Ctrl/Cmd+Enter commits from anywhere in the modal (not while capturing).
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !saveDisabled && !isCapturing && !isCapturingSignal) {
          e.preventDefault();
          handleSave();
          return;
        }
        const move = isCapturing || isCapturingSignal ? null : historyKey(e);
        if (move) {
          e.preventDefault();
          e.stopPropagation();
          if (move === "undo") history.undo(); else history.redo();
        }
      }}
    >
        <div className="action-picker__header">
          <div>
            <h2 id="action-picker-title">{t("picker.title")}</h2>
            {controlLabel ? (
              <p className="action-picker__subtitle">{controlLabel}{layerLabel ? ` · ${layerLabel}` : ""}</p>
            ) : null}
            {offline ? <p className="action-picker__subtitle">{t("picker.offlineHint")}</p> : null}
            {offline && offlineLiveLabel ? (
              <p className="action-picker__subtitle">{t("picker.offlineLiveAction", { label: offlineLiveLabel })}</p>
            ) : null}
          </div>
          <CloseButton onClick={requestClose} ariaLabel={t("common.close")} className="action-picker__close" />
        </div>

        {onGestureChange && controlId && profileId && selectedLayer && !offline ? (
          <div className="action-picker__gestures">
            <PillTrack
              className="pill-track--compact"
              items={GESTURES.map((key) => ({ key, label: t(GESTURE_LABEL_KEYS[key]) }))}
              active={gesture}
              onSelect={switchGesture}
              renderTrailing={(item) => {
                const other = findBinding(config, profileId, selectedLayer, controlId, item.key);
                const action = other ? config.actions.find((a) => a.id === other.actionId) : undefined;
                return other?.enabled && !isPlaceholderAction(action) ? (
                  <span className="action-picker__gesture-dot" aria-label={t("picker.gestureAssigned")}>•</span>
                ) : null;
              }}
            />
            <p className="panel__muted help-sm">{t("picker.gestureHelp")}</p>
          </div>
        ) : null}

        <div className="action-picker__body">
          <nav className="action-picker__categories">
            <input
              className="action-picker__search"
              type="text"
              placeholder={t("picker.searchPlaceholder")}
              aria-label={t("picker.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter jumps to the first match — keyboard-first category pick.
                if (e.key === "Enter" && filteredCategories[0]) {
                  e.preventDefault();
                  setSearchQuery("");
                  setActiveCategoryWithMemory(filteredCategories[0].id);
                }
              }}
              autoComplete="off"
            />
            {filteredCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`action-picker__cat-btn${effectiveCategory === cat.id ? " action-picker__cat-btn--active" : ""}`}
                onClick={() => { setSearchQuery(""); setActiveCategoryWithMemory(cat.id); }}
                aria-current={effectiveCategory === cat.id ? "true" : undefined}
                title={t(cat.label)}
              >
                <span className="action-picker__cat-icon"><CategoryIcon id={cat.id} fallback={cat.icon} /></span>
                <span className="action-picker__cat-label">{t(cat.label)}</span>
              </button>
            ))}
            {offline ? <button type="button"
              className={`action-picker__cat-btn${effectiveCategory === "native" ? " action-picker__cat-btn--active" : ""}`}
              disabled={!binding} aria-current={effectiveCategory === "native" ? "true" : undefined}
              onClick={() => { setSearchQuery(""); setActiveCategoryWithMemory("native"); }}>
              <span className="action-picker__cat-icon"><CategoryIcon id="native" fallback={inheritCategory.icon} /></span>
              <span className="action-picker__cat-label">{t("picker.offlineInherit")}</span>
            </button> : null}
            {filteredCategories.length === 0 ? (
              <p className="action-picker__no-results">{t("picker.noResults")}</p>
            ) : null}
          </nav>

          <div className="action-picker__editor">
            <div className="action-picker__cat-head">
              <span className="action-picker__cat-head-icon" aria-hidden="true">
                {activeCat ? <CategoryIcon id={activeCat.id} fallback={activeCat.icon} /> : null}
              </span>
              <div className="action-picker__cat-head-text">
                <h3 className="action-picker__cat-title">
                  {activeCat ? t(activeCat.label) : ""}
                </h3>
                <p className="action-picker__cat-desc">{t(categoryDescription)}</p>
              </div>
            </div>

            {effectiveCategory === "hypershift" ? (
              <div className="editor-grid">
                <Notice variant="info">{t("picker.hypershiftScope")}</Notice>
                {currentTrigger !== "none" && !isCurrentTrigger ? (
                  <Notice variant="warning">{t("picker.hypershiftReplace", { button: displayNameForControlId(currentTrigger) })}</Notice>
                ) : null}
              </div>
            ) : null}
            {effectiveCategory === "hypershift2" ? (
              <Notice variant="info">{t("picker.hypershift2Scope")}</Notice>
            ) : null}
            {effectiveCategory === "hypershift2" && hypershift2Conflict ? (
              <Notice variant="warning">{t("picker.hypershift2SoftwareConflict")}</Notice>
            ) : null}
            {isCurrentTrigger2 && effectiveCategory !== "hypershift2" ? (
              <Notice variant="warning">{t("picker.hypershift2Remove")}</Notice>
            ) : null}
            {effectiveCategory === "native" && !offline ? (
              <Notice variant="info">{t("picker.nativeHint")}</Notice>
            ) : null}
            {isCurrentTrigger && effectiveCategory !== "hypershift" ? (
              <Notice variant="warning">{t("picker.hypershiftRemove")}</Notice>
            ) : null}
            {effectiveCategory === "shortcut" ? (
              <ShortcutEditor
                draft={shortcutDraft}
                onChange={setShortcutDraft}
                isCapturing={isCapturing}
                setIsCapturing={setIsCapturing}
              />
            ) : null}

            {effectiveCategory === "mouseAction" ? (
              <MouseActionEditor draft={mouseDraft} onChange={setMouseDraft} searchQuery={searchQuery} offline={offline} />
            ) : null}
            {offlineUnplayable ? <Notice variant="warning">{t("picker.offlineUnstorable")}</Notice> : null}
            {offlineBlocked ? <Notice variant="warning">{t("offline.notEditable")}</Notice> : null}

            {effectiveCategory === "textSnippet" ? (
              <TextSnippetEditor
                draft={textDraft}
                onChange={setTextDraft}
                library={config.snippetLibrary}
                uses={snippetPlaceCounts(config)}
                saveToLibrary={saveSnippetToLibrary}
                onToggleSaveToLibrary={setSaveSnippetToLibrary}
                onPickName={setNameDraft}
              />
            ) : null}

            {effectiveCategory === "sequence" ? (
              <SequenceStepEditor
                steps={sequenceDraft}
                onChange={setSequenceDraft}
              />
            ) : null}

            {effectiveCategory === "launch" ? (
              <LaunchEditor draft={launchDraft} onChange={setLaunchDraft} />
            ) : null}

            {effectiveCategory === "menu" ? (
              <MenuItemsEditor
                items={menuItemsDraft}
                onChange={setMenuItemsDraft}
                config={config}
                edits={menuEdits}
                onEditsChange={setMenuEdits}
                menuActionId={existingAction?.id}
                initialSelectedId={focusMenuItemId}
                name={nameDraft}
                namePlaceholder={autoName("menu", drafts, t, config.profiles)}
                onNameChange={setNameDraft}
                sharedUses={existingAction?.type === "menu" ? sharedUses : 0}
              />
            ) : null}

            {effectiveCategory === "mediaKey" ? (
              <MediaKeyEditor value={mediaDraft} onChange={setMediaDraft} />
            ) : null}

            {effectiveCategory === "profileSwitch" ? (
              <ProfileSwitchEditor
                value={profileDraft}
                onChange={setProfileDraft}
                profiles={config.profiles}
              />
            ) : null}

            {effectiveCategory === "disabled" ? (
              <div className="editor-grid">
                <Notice variant="info">{t(offline ? "picker.offlineSilentHint" : "picker.disabledHint")}</Notice>
              </div>
            ) : null}

            {effectiveCategory === "repairClipboard" ? (
              <div className="editor-grid">
                <Notice variant="info">{t("picker.repairClipboardHint")}</Notice>
              </div>
            ) : null}

            {effectiveCategory === "stopMacros" ? (
              <div className="editor-grid">
                <Notice variant="info">{t("picker.stopMacrosHint")}</Notice>
              </div>
            ) : null}

            {effectiveCategory === "cheatSheet" ? (
              <div className="editor-grid">
                <SelectField<Layer>
                  label={t("picker.cheatSheetLayer")}
                  value={cheatLayerDraft}
                  onChange={setCheatLayerDraft}
                  options={(["standard", "hypershift", "hypershift2", "hypershiftBoth"] as const).map((layer) => ({ value: layer, label: labelForLayer(layer) }))}
                />
                <Notice variant="info">{t("picker.cheatSheetHint")}</Notice>
              </div>
            ) : null}

            {controlId && selectedLayer && !builtinControl && !offline ? (
              <SignalCaptureField
                signalDraft={signalDraft}
                onChange={setSignalDraft}
                isCapturing={isCapturingSignal}
                setIsCapturing={setIsCapturingSignal}
                expectedSignal={expectedSignal}
              />
            ) : null}

            {/* The menu editor has the name in its own top bar. */}
            {!offline && !roleCategory && effectiveCategory !== "menu" ? <label className="field mt-12">
              <span className="field__label">
                {t("picker.nameLabel")}
                <HelpTip text={t("picker.nameHelp")} />
              </span>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={autoName(ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.actionType ?? "disabled", drafts, t, config.profiles)}
              />
            </label> : null}

            {!offline && !roleCategory ? <details
              className="advanced-section picker-advanced mt-12"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
            >
              <summary className="advanced-section__toggle picker-advanced__summary">
                <span className="picker-advanced__title">{t("picker.advancedTitle")}</span>
                {!advancedOpen ? <span className="picker-advanced__tags">{advancedSummary}</span> : null}
              </summary>
              <div className="picker-advanced__body">
                <div className={`picker-two-col${triggerModeDraft === "chord" ? " picker-two-col--single" : ""}`}>
                  {gesture === "press" ? <TriggerModeEditor
                    triggerMode={triggerModeDraft}
                    onChange={setTriggerModeDraft}
                    chordPartner={chordPartnerDraft}
                    setChordPartner={setChordPartnerDraft}
                    controlId={controlId}
                    selectedLayer={selectedLayer}
                    physicalControls={config.physicalControls}
                    bindings={config.bindings}
                    sideButtonsOneAtATime={keyButton && consumerSignals}
                  /> : null}
                  <label className="field">
                    <span className="field__label">
                      {t("picker.throttleLabel")}
                      <HelpTip text={t("picker.throttleHelp")} />
                    </span>
                    <div className="input-suffix">
                      <input
                        type="number"
                        min={0}
                        max={5000}
                        step={50}
                        value={throttleDraft}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          const clamped = Number.isFinite(parsed)
                            ? Math.min(5000, Math.max(0, Math.round(parsed)))
                            : 0;
                          setThrottleDraft(clamped);
                        }}
                      />
                      <span className="input-suffix__unit">{t("picker.throttleUnit")}</span>
                    </div>
                  </label>
                </div>
                <ConditionsEditor conditions={conditionsDraft} onChange={setConditionsDraft} />
              </div>
            </details> : null}
          </div>
        </div>

        <p className="action-picker__preview">
          <span className="action-picker__preview-label">{t("picker.previewLabel")}</span>
          <span className="action-picker__preview-text">{previewText}</span>
          {hardwareStatus ? (
            <span
              className={`action-picker__hw-badge action-picker__hw-badge--${hardwareStatus.location}`}
              title={hardwareReason ?? t("offline.inMouseTooltip")}
            >
              <GestureIcon mark={hardwareStatus.location === "mouse" ? "memory" : "live"} />
              <span>
                {t(hardwareStatus.location === "mouse" ? "offline.badgeInMouse" : "offline.badgeSidearmOnly")}
                {hardwareReason ? ` · ${hardwareReason}` : ""}
              </span>
            </span>
          ) : null}
        </p>
        {!offline && builtinControl ? (
          selectedLayer === "standard" || selectedLayer === "hypershift" ? (
            gesture === "press" && triggerModeDraft === "press" ? (
              <details className="action-picker__offline">
                <summary className="action-picker__preview" title={offlineSummary}>
                  <ChevronIcon />
                  <span className="action-picker__preview-label">{t("offline.view")}:</span>
                  <span className="action-picker__preview-text">{offlineSummary}</span>
                </summary>
                {offlineControl?.editable ? <div className="action-picker__offline-actions">
                  <button type="button" className="action-button action-button--small" aria-pressed={offlineChoice === null}
                    onClick={() => setOfflineChoice(null)}>{t("offline.inherit")}</button>
                  <button type="button" className="action-button action-button--small" aria-pressed={offlineChoice === "silent"}
                    onClick={() => setOfflineChoice("silent")}>{t("offline.mute")}</button>
                  <button type="button" className="action-button action-button--small" disabled={saveDisabled}
                    onClick={switchToOffline}>{t("offline.setOwn")}</button>
                </div> : null}
              </details>
            ) : <p className="action-picker__uses">{t("offline.plainPressOnly")}</p>
          ) : null
        ) : null}
        {elsewhere.length > 0 ? (
          <p className="action-picker__uses">
            {t("picker.alsoUsed", { places: elsewhere.slice(0, 4).join("; ") })}
            {elsewhere.length > 4 ? ` ${t("picker.alsoUsedMore", { count: elsewhere.length - 4 })}` : ""}
          </p>
        ) : null}

        {testResult ? (
          <div className="action-picker__test-result">
            <Notice variant={testResult.ok ? "ok" : "error"}>{testResult.text}</Notice>
          </div>
        ) : null}

        {syncReplaced.length > 0 ? (
          <div className="action-picker__sync-note">
            {syncReplaced.map((item) => (
              <Notice key={item.id} variant="warning">{t("picker.syncReplaces", { action: item.action, mouse: item.mouse })}</Notice>
            ))}
          </div>
        ) : null}

        <ModalFooter className="action-picker__footer">
          {syncKey ? (
            <span className="action-picker__sync">
              <Toggle checked={syncDraft} onChange={setSyncDraft} ariaLabel={t("picker.syncOther", { mice: otherMice.map((device) => device.name).join(", ") })} />
              <span>{t("picker.syncOther", { mice: otherMice.map((device) => device.name).join(", ") })}</span>
              <HelpTip text={t("picker.syncOtherHint")} />
            </span>
          ) : null}
          <div className="action-picker__history">
            <button type="button" className="action-button action-button--ghost" onClick={history.undo}
              disabled={!history.canUndo} aria-label={t("picker.undo")} title={t("picker.undo")}>↶</button>
            <button type="button" className="action-button action-button--ghost" onClick={history.redo}
              disabled={!history.canRedo} aria-label={t("picker.redo")} title={t("picker.redo")}>↷</button>
          </div>
          <button type="button" className="action-button action-button--ghost" onClick={requestClose}>
            {t("common.cancel")}
          </button>
          {!offline && !roleCategory ? <button
            type="button"
            className="action-button action-button--ghost"
            onClick={handleTest}
            disabled={saveDisabled || testRunning}
          >
            {t("picker.test")}
          </button> : null}
          <button
            type="button"
            className="action-button action-button--accent"
            onClick={handleSave}
            disabled={saveDisabled}
          >
            {t("common.save")}
          </button>
        </ModalFooter>
    </ModalShell>
    {askDiscard ? (
      <ConfirmModal
        title={t("picker.discardTitle")}
        message={t("picker.discardMessage")}
        confirmLabel={t("picker.discard")}
        cancelLabel={t("picker.keepEditing")}
        danger
        onConfirm={onCancel}
        onCancel={() => setAskDiscard(false)}
      />
    ) : null}
    </>
  );
}
