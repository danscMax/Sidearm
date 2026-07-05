import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Layer } from "../lib/config";
import { ACTION_CATEGORIES } from "../lib/constants";
import { liveTestAction, listenEncodedKeyEvent, normalizeCommandError } from "../lib/backend";
import {
  expectedEncodedKeyForControl,
  isPlaceholderAction,
  promoteInlineSnippetActionToLibrary,
  upsertAction,
  upsertBinding,
  upsertEncoderMapping,
} from "../lib/config-editing";
import { MenuItemsEditor } from "./MenuItemsEditor";
import { CloseButton, ModalFooter, ModalShell, Notice } from "./shared";
import {
  autoName,
  buildAction,
  createInitialDrafts,
  isSaveDisabled,
  type PickerDrafts,
} from "../lib/action-picker-helpers";
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

export function ActionPickerModal({
  config,
  bindingId,
  controlLabel,
  layerLabel,
  controlId,
  selectedLayer,
  onSave,
  onCancel,
}: {
  config: AppConfig;
  bindingId: string | null;
  controlLabel?: string;
  layerLabel?: string;
  controlId?: ControlId;
  selectedLayer?: Layer;
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
  const existingAction = binding
    ? config.actions.find((a) => a.id === binding.actionId) ?? null
    : null;

  // Encoder signal state
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
    if (existingAction) {
      return ACTION_CATEGORIES.find((c) => c.actionType === existingAction.type)?.id ?? "shortcut";
    }
    const lastCategory =
      localStorage.getItem(LAST_PICKER_CATEGORY_KEY) ??
      localStorage.getItem(LEGACY_LAST_PICKER_CATEGORY_KEY);
    return lastCategory && ACTION_CATEGORIES.some((c) => c.id === lastCategory) ? lastCategory : "shortcut";
  });

  function setActiveCategoryWithMemory(cat: string) {
    setActiveCategory(cat);
    setNameDraft("");
    localStorage.setItem(LAST_PICKER_CATEGORY_KEY, cat);
    localStorage.removeItem(LEGACY_LAST_PICKER_CATEGORY_KEY);
  }
  const [searchQuery, setSearchQuery] = useState("");

  const filteredCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ACTION_CATEGORIES;
    return ACTION_CATEGORIES.filter((cat) =>
      [
        cat.id,
        cat.actionType,
        t(cat.label),
        t(`action.type.${cat.actionType}`),
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [searchQuery, t]);

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
  const [nameDraft, setNameDraft] = useState(initial.name);
  const [triggerModeDraft, setTriggerModeDraft] = useState(initial.triggerMode);
  const [chordPartnerDraft, setChordPartnerDraft] = useState(initial.chordPartner);
  const [throttleDraft, setThrottleDraft] = useState(initial.throttleMs);
  const [conditionsDraft, setConditionsDraft] = useState(initial.conditions);
  const [menuItemsDraft, setMenuItemsDraft] = useState(initial.menuItems);

  const menuActionOptions = useMemo(
    () =>
      existingAction
        ? config.actions.filter((a) => a.id !== existingAction.id)
        : config.actions,
    [config.actions, existingAction],
  );

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

  function handleSave() {
    const nextAction = buildAction({ effectiveCategory, existingAction, drafts, t, profiles: config.profiles });
    let nextConfig = upsertAction(config, nextAction);

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

    if (binding) {
      nextConfig = upsertBinding(nextConfig, {
        ...binding,
        actionId: nextAction.id,
        label: nextAction.displayName,
        // Preserve enabled state only when editing a REAL saved action; a
        // first-time assignment sits on a disabled placeholder action+binding
        // (enabled:false), so treat placeholder as "new" and enable it.
        enabled: existingAction && !isPlaceholderAction(existingAction) ? binding.enabled : true,
        triggerMode: triggerModeDraft === "press" ? undefined : triggerModeDraft,
        chordPartner: triggerModeDraft === "chord" && chordPartnerDraft
          ? chordPartnerDraft as ControlId
          : undefined,
        throttleMs: throttleDraft > 0 ? throttleDraft : undefined,
      });
    }

    // Save encoder mapping if signal was set/changed
    if (controlId && selectedLayer && signalDraft && signalDraft !== currentEncoderMapping?.encodedKey) {
      nextConfig = upsertEncoderMapping(nextConfig, {
        controlId,
        layer: selectedLayer,
        encodedKey: signalDraft,
        source: "detected",
        verified: false,
      });
    }

    onSave(nextConfig);
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
      const result = await liveTestAction(draftAction);
      const detail =
        result.warnings.length > 0
          ? `${result.summary} — ${result.warnings.join("; ")}`
          : result.summary;
      setTestResult({ ok: true, text: detail });
    } catch (error) {
      setTestResult({ ok: false, text: normalizeCommandError(error).message });
    } finally {
      setTestRunning(false);
    }
  }

  return (
    <ModalShell
      onClose={onCancel}
      className="modal action-picker"
      dialogRef={modalRef}
      ariaLabelledby="action-picker-title"
      escapeEnabled={!isCapturing && !isCapturingSignal}
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

        <div className="action-picker__body">
          <nav className="action-picker__categories">
            <input
              className="action-picker__search"
              type="text"
              placeholder={t("picker.searchPlaceholder")}
              aria-label={t("picker.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoComplete="off"
            />
            {filteredCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`action-picker__cat-btn${effectiveCategory === cat.id ? " action-picker__cat-btn--active" : ""}`}
                onClick={() => { setSearchQuery(""); setActiveCategoryWithMemory(cat.id); }}
                title={t(cat.label)}
              >
                <span className="action-picker__cat-icon">{cat.icon}</span>
                <span className="action-picker__cat-label">{t(cat.label)}</span>
              </button>
            ))}
          </nav>

          <div className="action-picker__editor">
            <h3 className="action-picker__cat-title">
              {(() => {
                const key = ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.label;
                return key ? t(key) : "";
              })()}
            </h3>

            {effectiveCategory === "shortcut" ? (
              <ShortcutEditor
                draft={shortcutDraft}
                onChange={setShortcutDraft}
                isCapturing={isCapturing}
                setIsCapturing={setIsCapturing}
              />
            ) : null}

            {effectiveCategory === "mouseAction" ? (
              <MouseActionEditor draft={mouseDraft} onChange={setMouseDraft} />
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
                <Notice variant="warning">{t("picker.menuLiveHint")}</Notice>
                <MenuItemsEditor
                  items={menuItemsDraft}
                  onChange={setMenuItemsDraft}
                  availableActions={menuActionOptions}
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
                <p className="panel__muted">
                  {t("picker.disabledHint")}
                </p>
              </div>
            ) : null}

            {effectiveCategory === "repairClipboard" ? (
              <div className="editor-grid">
                <p className="panel__muted">
                  {t("picker.repairClipboardHint")}
                </p>
              </div>
            ) : null}

            {controlId && selectedLayer ? (
              <SignalCaptureField
                signalDraft={signalDraft}
                onChange={setSignalDraft}
                isCapturing={isCapturingSignal}
                setIsCapturing={setIsCapturingSignal}
                expectedSignal={expectedSignal}
              />
            ) : null}

            <label className="field mt-12">
              <span className="field__label">{t("picker.nameLabel")}</span>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={autoName(ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.actionType ?? "disabled", drafts, t, config.profiles)}
              />
            </label>

            <ConditionsEditor conditions={conditionsDraft} onChange={setConditionsDraft} />

            <TriggerModeEditor
              triggerMode={triggerModeDraft}
              onChange={setTriggerModeDraft}
              chordPartner={chordPartnerDraft}
              setChordPartner={setChordPartnerDraft}
              controlId={controlId}
              selectedLayer={selectedLayer}
              physicalControls={config.physicalControls}
              bindings={config.bindings}
            />

            <label className="field mt-12">
              <span className="field__label">{t("picker.throttleLabel")}</span>
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
              <span className="panel__muted">{t("picker.throttleHelp")}</span>
            </label>
          </div>
        </div>

        {testResult ? (
          <p
            className={`action-picker__test-result${testResult.ok ? "" : " action-picker__test-result--error"}`}
            role="status"
          >
            {testResult.text}
          </p>
        ) : null}

        <ModalFooter className="action-picker__footer">
          <button type="button" className="action-button action-button--ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="action-button action-button--ghost"
            onClick={handleTest}
            disabled={isSaveDisabled(effectiveCategory, drafts) || testRunning}
          >
            {t("picker.test")}
          </button>
          <button
            type="button"
            className="action-button action-button--primary"
            onClick={handleSave}
            disabled={isSaveDisabled(effectiveCategory, drafts)}
          >
            {t("common.save")}
          </button>
        </ModalFooter>
    </ModalShell>
  );
}
