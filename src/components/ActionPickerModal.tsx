import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Layer } from "../lib/config";
import { NATIVE_HYPERSHIFT_TRIGGERS, type HypershiftTrigger } from "../lib/config";
import { displayNameForControlId } from "../lib/labels";
import { ACTION_CATEGORIES, MOUSE_ACTION_OPTIONS } from "../lib/constants";
import { isBuiltinControl, isKeyButton } from "../lib/onboard-mapping";
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
  promoteInlineSnippetActionToLibrary,
  upsertAction,
  upsertBinding,
  upsertEncoderMapping,
} from "../lib/config-editing";
import { MenuItemsEditor } from "./MenuItemsEditor";
import { applyMenuEdits, isMenuIncomplete, NO_MENU_EDITS, type MenuEdits } from "../lib/menu-phrase";
import { CloseButton, HelpTip, ModalFooter, ModalShell, Notice } from "./shared";
import {
  autoName,
  buildAction,
  createInitialDrafts,
  describeAction,
  isSaveDisabled,
  type PickerDrafts,
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

export function ActionPickerModal({
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
}: {
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
}) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Save previously focused element and restore on unmount
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
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


  const binding = bindingId ? config.bindings.find((b) => b.id === bindingId) ?? null : null;
  const savedAction = binding
    ? config.actions.find((a) => a.id === binding.actionId) ?? null
    : null;
  const existingAction = isPlaceholderAction(savedAction) ? null : savedAction;
  // Other buttons using this very action (one menu for both mice, say).
  const sharedUses = existingAction && binding
    ? config.bindings.filter((b) => b.actionId === existingAction.id && b.id !== binding.id).length
    : 0;

  // Encoder signal state (user devices only — see isBuiltinControl)
  const builtinControl = controlId ? isBuiltinControl(config, controlId) : false;
  const layout = controlId ? controlLayout(config, controlId) : undefined;
  // A firmware trigger is fixed in the mouse; only the software one can move.
  const softwareTrigger = builtinControl && !layout?.firmwareTrigger;
  const currentTrigger = softwareTrigger ? config.settings.hypershiftTrigger ?? "mouse_right" : "none";
  // The role sits on the plain press (the button never clicks) or on the
  // held press (a quick press still clicks: `hypershiftTap`).
  const roleTab: Gesture = config.settings.hypershiftTap ? "longPress" : "press";
  const isCurrentTrigger = softwareTrigger && controlId === currentTrigger && gesture === roleTab;
  const canBeTrigger = softwareTrigger && NATIVE_HYPERSHIFT_TRIGGERS.some((id) => id === controlId);
  // HyperShift 2 is per profile and only a held press (a quick press clicks).
  const canBeTrigger2 = !!controlId && !!profileId && canBeHypershift2Trigger(config, controlId);
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
  const categories = [
    { id: "native", icon: "↺", label: "picker.native", actionType: "native" },
    ...(canBeTrigger && (gesture === "press" || gesture === "longPress") ? [{ id: "hypershift", icon: "HS", label: "picker.hypershift", actionType: "hypershift" }] : []),
    ...(canBeTrigger2 && gesture === "longPress" ? [{ id: "hypershift2", icon: "H2", label: "picker.hypershift2", actionType: "hypershift2" }] : []),
    ...ACTION_CATEGORIES,
  ];
  // The mouse reports one key button at a time only with consumer signals; in
  // F13..F24 mode two arrive together. Asked once per opened key button.
  const keyButton = builtinControl && controlId !== undefined && isKeyButton(layoutControlId(controlId));
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

  const [signalDraft, setSignalDraft] = useState<string | null>(
    () => currentEncoderMapping?.encodedKey ?? null,
  );
  const [isCapturingSignal, setIsCapturingSignal] = useState(false);

  const [activeCategory, setActiveCategory] = useState(() => {
    if (isCurrentTrigger) return "hypershift";
    if (isCurrentTrigger2) return "hypershift2";
    if (existingAction) {
      return ACTION_CATEGORIES.find((c) => c.actionType === existingAction.type)?.id ?? "shortcut";
    }
    return "native";
  });

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
      ...(cat.actionType === "mouseAction" ? MOUSE_ACTION_OPTIONS.flatMap((item) => [item.value, t(item.label)]) : []),
    ].some((text) => text.toLowerCase().includes(query)),
  );

  const effectiveCategory = filteredCategories.some((c) => c.id === activeCategory)
    ? activeCategory
    : filteredCategories[0]?.id ?? "shortcut";

  const [isCapturing, setIsCapturing] = useState(false);

  // Draft action state per category — seeded once from the edited action/binding
  const initial = useMemo(
    () => createInitialDrafts(existingAction, binding, config.profiles, config.snippetLibrary),
    [existingAction, binding, config.profiles, config.snippetLibrary],
  );
  const [shortcutDraft, setShortcutDraft] = useState(initial.shortcut);
  const [mouseDraft, setMouseDraft] = useState(initial.mouse);
  const [textDraft, setTextDraft] = useState(initial.text);
  // Default ON so snippet text lands in the durable library, not only inline on
  // the button — inline-only text is silently lost when the button is later
  // reassigned. Snippets already backed by the library don't need re-saving.
  const [saveSnippetToLibrary, setSaveSnippetToLibrary] = useState(
    () =>
      !(
        existingAction?.type === "textSnippet" &&
        existingAction.payload.source === "libraryRef"
      ),
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [launchDraft, setLaunchDraft] = useState(initial.launch);
  const [mediaDraft, setMediaDraft] = useState(initial.media);
  const [profileDraft, setProfileDraft] = useState(initial.profile);
  const [sequenceDraft, setSequenceDraft] = useState(initial.sequence);
  const [nameDraft, setNameDraft] = useState(isPlaceholderAction(existingAction) ? "" : initial.name);
  const [triggerModeDraft, setTriggerModeDraft] = useState(initial.triggerMode);
  const [chordPartnerDraft, setChordPartnerDraft] = useState(initial.chordPartner);
  const [throttleDraft, setThrottleDraft] = useState(initial.throttleMs);
  const [conditionsDraft, setConditionsDraft] = useState(initial.conditions);
  const [menuItemsDraft, setMenuItemsDraft] = useState(initial.menuItems);

  // Advanced settings (trigger mode, throttle, conditions) collapse by default,
  // but open automatically when the edited action already has any of them set.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => initial.triggerMode !== "press" || initial.throttleMs > 0 || initial.conditions.length > 0,
  );

  // Phrase texts and new phrase actions edited in the menu editor, written on Save.
  const [menuEdits, setMenuEdits] = useState<MenuEdits>(NO_MENU_EDITS);

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
    name: nameDraft,
    conditions: conditionsDraft,
  };

  /** The config with this tab's edit in it; null when it cannot be saved. */
  function buildSave(): AppConfig | null {
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
    // An action other buttons use too is edited for this button alone, except a
    // shared menu edited as a menu: keeping it one menu is why it is shared.
    if (existingAction && sharedUses > 0 && !(existingAction.type === "menu" && nextAction.type === "menu")) {
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

  function handleSave() {
    const next = buildSave();
    if (next) onSave(next);
  }

  /** Another press pattern's tab: this tab's edit is kept (applied without
   *  closing), so several patterns can be set in one go. */
  function switchGesture(next: Gesture) {
    if (next === gesture || !onGestureChange) return;
    const saved = saveDisabled ? null : buildSave();
    if (saved && saved !== config) onApply?.(saved);
    onGestureChange(next);
  }

  async function handleTest() {
    if (testRunning) return;
    const draftAction = buildAction({ effectiveCategory, existingAction, drafts, t, profiles: config.profiles });
    setTestRunning(true);
    try {
      // Launch/URL/folder don't depend on focus — run immediately. Input
      // actions (keys, text, media, macro) go to the focused window, so count
      // down to let the user switch to their target window first.
      if (effectiveCategory !== "launch") {
        for (let n = 3; n > 0; n -= 1) {
          setTestResult({ ok: true, text: t("picker.testCountdown", { n }) });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      const result = await liveTestAction(draftAction, profileId ?? binding?.profileId);
      const detail =
        result.warnings.length > 0
          ? `${uiText(result.summary)} — ${result.warnings.map(uiText).join("; ")}`
          : uiText(result.summary);
      setTestResult({ ok: true, text: detail });
    } catch (error) {
      setTestResult({ ok: false, text: normalizeCommandError(error).message });
    } finally {
      setTestRunning(false);
    }
  }

  const roleCategory = effectiveCategory === "native" || effectiveCategory === "hypershift" || effectiveCategory === "hypershift2";
  const saveDisabled = roleCategory
    ? false
    : isSaveDisabled(effectiveCategory, drafts)
      || (effectiveCategory === "menu" && isMenuIncomplete(config, menuEdits, menuItemsDraft));
  const activeConditionsCount = conditionsDraft.filter((c) => c.value.trim()).length;
  const advancedTags = [
    triggerModeDraft !== "press" ? t(TRIGGER_LABEL_KEYS[triggerModeDraft]) : null,
    throttleDraft > 0 ? t("picker.advancedThrottleTag", { ms: throttleDraft }) : null,
    activeConditionsCount > 0 ? t("picker.advancedConditionsTag", { count: activeConditionsCount }) : null,
  ].filter(Boolean);
  const advancedSummary = advancedTags.length > 0 ? advancedTags.join(" · ") : t("picker.advancedDefaults");
  const previewText = roleCategory
    ? t(effectiveCategory === "hypershift" ? "picker.hypershiftPreview"
      : effectiveCategory === "hypershift2" ? "picker.hypershift2Preview" : "picker.nativePreview")
    : describeAction(effectiveCategory, drafts, t, config.profiles);
  const activeCat = categories.find((c) => c.id === effectiveCategory);

  return (
    <ModalShell
      onClose={onCancel}
      className="modal action-picker"
      dialogRef={modalRef}
      ariaLabelledby="action-picker-title"
      escapeEnabled={!isCapturing && !isCapturingSignal}
      onKeyDown={(e) => {
        // Ctrl/Cmd+Enter commits from anywhere in the modal (not while capturing).
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !saveDisabled && !isCapturing && !isCapturingSignal) {
          e.preventDefault();
          handleSave();
        }
      }}
    >
        <div className="action-picker__header">
          <div>
            <h2 id="action-picker-title">{t("picker.title")}</h2>
            {controlLabel ? (
              <p className="action-picker__subtitle">{controlLabel}{layerLabel ? ` · ${layerLabel}` : ""}</p>
            ) : null}
          </div>
          <CloseButton onClick={onCancel} ariaLabel={t("common.close")} className="action-picker__close" />
        </div>

        {onGestureChange && controlId && profileId && selectedLayer ? (
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
                <span className="action-picker__cat-icon">{cat.icon}</span>
                <span className="action-picker__cat-label">{t(cat.label)}</span>
              </button>
            ))}
            {filteredCategories.length === 0 ? (
              <p className="action-picker__no-results">{t("picker.noResults")}</p>
            ) : null}
          </nav>

          <div className="action-picker__editor">
            <div className="action-picker__cat-head">
              <span className="action-picker__cat-head-icon" aria-hidden="true">
                {activeCat?.icon}
              </span>
              <div className="action-picker__cat-head-text">
                <h3 className="action-picker__cat-title">
                  {activeCat ? t(activeCat.label) : ""}
                </h3>
                <p className="action-picker__cat-desc">{t(`picker.categoryDesc.${effectiveCategory}`)}</p>
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
            {effectiveCategory === "native" ? (
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
              <MouseActionEditor draft={mouseDraft} onChange={setMouseDraft} searchQuery={searchQuery} />
            ) : null}

            {effectiveCategory === "textSnippet" ? (
              <TextSnippetEditor
                draft={textDraft}
                onChange={setTextDraft}
                library={config.snippetLibrary}
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
              <div className="editor-grid">
                {existingAction?.type === "menu" && sharedUses > 0 ? (
                  <Notice variant="info">{t("picker.menuShared", { count: sharedUses })}</Notice>
                ) : null}
                <MenuItemsEditor
                  items={menuItemsDraft}
                  onChange={setMenuItemsDraft}
                  config={config}
                  edits={menuEdits}
                  onEditsChange={setMenuEdits}
                  menuActionId={existingAction?.id}
                  initialSelectedId={focusMenuItemId}
                />
              </div>
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
                <Notice variant="info">{t("picker.disabledHint")}</Notice>
              </div>
            ) : null}

            {effectiveCategory === "repairClipboard" ? (
              <div className="editor-grid">
                <Notice variant="info">{t("picker.repairClipboardHint")}</Notice>
              </div>
            ) : null}

            {controlId && selectedLayer && !builtinControl ? (
              <SignalCaptureField
                signalDraft={signalDraft}
                onChange={setSignalDraft}
                isCapturing={isCapturingSignal}
                setIsCapturing={setIsCapturingSignal}
                expectedSignal={expectedSignal}
              />
            ) : null}

            {!roleCategory ? <label className="field mt-12">
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

            {!roleCategory ? <details
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
        </p>

        {testResult ? (
          <div className="action-picker__test-result">
            <Notice variant={testResult.ok ? "ok" : "error"}>{testResult.text}</Notice>
          </div>
        ) : null}

        <ModalFooter className="action-picker__footer">
          <button type="button" className="action-button action-button--ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          {!roleCategory ? <button
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
  );
}
