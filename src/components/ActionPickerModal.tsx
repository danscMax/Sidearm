import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Layer } from "../lib/config";
import { ACTION_CATEGORIES } from "../lib/constants";
import { liveTestAction, listenEncodedKeyEvent, normalizeCommandError } from "../lib/backend";
import {
  expectedEncodedKeyForControl,
  isPlaceholderAction,
  makeSnippetId,
  upsertAction,
  upsertBinding,
  upsertEncoderMapping,
  upsertSnippetLibraryItem,
} from "../lib/config-editing";
import { MenuItemsEditor } from "./MenuItemsEditor";
import { ModalShell } from "./shared";
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

  // Auto-focus first interactive element on mount
  useEffect(() => {
    const container = modalRef.current;
    if (!container) return;
    const firstFocusable = container.querySelector<HTMLElement>(
      'input, button, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();
  }, []);


  const binding = bindingId ? config.bindings.find((b) => b.id === bindingId) ?? null : null;
  const existingAction = binding
    ? config.actions.find((a) => a.id === binding.actionRef) ?? null
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
    const lastCategory = localStorage.getItem("naga-studio:lastPickerCategory");
    return lastCategory && ACTION_CATEGORIES.some((c) => c.id === lastCategory) ? lastCategory : "shortcut";
  });

  function setActiveCategoryWithMemory(cat: string) {
    setActiveCategory(cat);
    setNameDraft("");
    localStorage.setItem("naga-studio:lastPickerCategory", cat);
  }
  const [searchQuery, setSearchQuery] = useState("");

  const filteredCategories = searchQuery.trim()
    ? ACTION_CATEGORIES.filter((cat) =>
        cat.label.toLowerCase().includes(searchQuery.trim().toLowerCase())
      )
    : ACTION_CATEGORIES;

  const effectiveCategory = filteredCategories.some((c) => c.id === activeCategory)
    ? activeCategory
    : filteredCategories[0]?.id ?? "shortcut";

  const [isCapturing, setIsCapturing] = useState(false);

  // Draft action state per category — seeded once from the edited action/binding
  const initial = useMemo(
    () => createInitialDrafts(existingAction, binding, config.profiles),
    [existingAction, binding, config.profiles],
  );
  const [shortcutDraft, setShortcutDraft] = useState(initial.shortcut);
  const [mouseDraft, setMouseDraft] = useState(initial.mouse);
  const [textDraft, setTextDraft] = useState(initial.text);
  const [saveSnippetToLibrary, setSaveSnippetToLibrary] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [launchDraft, setLaunchDraft] = useState(initial.launch);
  const [mediaDraft, setMediaDraft] = useState(initial.media);
  const [profileDraft, setProfileDraft] = useState(initial.profile);
  const [sequenceDraft, setSequenceDraft] = useState(initial.sequence);
  const [nameDraft, setNameDraft] = useState(initial.name);
  const [triggerModeDraft, setTriggerModeDraft] = useState(initial.triggerMode);
  const [chordPartnerDraft, setChordPartnerDraft] = useState(initial.chordPartner);
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

    // Opt-in: also store this snippet's text in the reusable library.
    if (saveSnippetToLibrary && effectiveCategory === "textSnippet" && textDraft.text.trim()) {
      const snippetName = nameDraft.trim() || nextAction.pretty || textDraft.text.trim().slice(0, 30);
      nextConfig = upsertSnippetLibraryItem(nextConfig, {
        id: makeSnippetId(snippetName),
        name: snippetName,
        text: textDraft.text,
        pasteMode: textDraft.pasteMode,
        tags: [],
      });
    }

    if (binding) {
      nextConfig = upsertBinding(nextConfig, {
        ...binding,
        actionRef: nextAction.id,
        label: nextAction.pretty,
        // Preserve enabled state only when editing a REAL saved action; a
        // first-time assignment sits on a disabled placeholder action+binding
        // (enabled:false), so treat placeholder as "new" and enable it.
        enabled: existingAction && !isPlaceholderAction(existingAction) ? binding.enabled : true,
        triggerMode: triggerModeDraft === "press" ? undefined : triggerModeDraft,
        chordPartner: triggerModeDraft === "chord" && chordPartnerDraft
          ? chordPartnerDraft as ControlId
          : undefined,
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
          <button type="button" className="action-picker__close" onClick={onCancel} aria-label={t("common.close")}>×</button>
        </div>

        <div className="action-picker__body">
          <nav className="action-picker__categories">
            <input
              className="action-picker__search"
              type="text"
              placeholder={t("picker.searchPlaceholder")}
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
                title={cat.label}
              >
                <span className="action-picker__cat-icon">{cat.icon}</span>
                <span className="action-picker__cat-label">{cat.label}</span>
              </button>
            ))}
          </nav>

          <div className="action-picker__editor">
            <h3 className="action-picker__cat-title">
              {ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.label}
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
              />
            ) : null}

            {effectiveCategory === "sequence" ? (
              <SequenceStepEditor
                steps={sequenceDraft}
                onUpdate={setSequenceDraft}
              />
            ) : null}

            {effectiveCategory === "launch" ? (
              <LaunchEditor draft={launchDraft} onChange={setLaunchDraft} />
            ) : null}

            {effectiveCategory === "menu" ? (
              <div className="editor-grid">
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
                setSignalDraft={setSignalDraft}
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

        <div className="action-picker__footer">
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
        </div>
    </ModalShell>
  );
}
