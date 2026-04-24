import { useEffect, useRef, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Action,
  ActionCondition,
  ActionType,
  AppConfig,
  ControlId,
  Layer,
  MediaKeyKind,
  MouseActionKind,
  PasteMode,
  SequenceStep,
  ShortcutActionPayload,
  TriggerMode,
} from "../lib/config";
import {
  ACTION_CATEGORIES,
  MEDIA_KEY_OPTIONS,
  MOUSE_ACTION_OPTIONS,
} from "../lib/constants";
import { labelForSequenceStep } from "../lib/labels";
import {
  coerceSequenceStepType,
  createDefaultSequenceStep,
  setSequenceStepDelay,
} from "../lib/action-helpers";
import {
  startMacroRecording,
  recordKeystroke,
  stopMacroRecording,
  listenEncodedKeyEvent,
} from "../lib/backend";
import {
  expectedEncodedKeyForControl,
  upsertAction,
  upsertBinding,
  upsertEncoderMapping,
} from "../lib/config-editing";
import { Toggle } from "./shared";

/* ─────────────────────────────────────────────────────────
   Normalize Key Name
   ───────────────────────────────────────────────────────── */

const KEY_NAME_MAP: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

/** Resolve the human-readable key name from a KeyboardEvent.
 *  Chromium returns key="Unidentified" and code="" for F13-F24 (sent via SendInput).
 *  In that case, fall back to the deprecated keyCode (124=F13 … 135=F24). */
function resolveKeyName(event: KeyboardEvent | React.KeyboardEvent): string {
  // 1. Try event.key
  if (event.key && event.key !== "Unidentified") return event.key;
  // 2. Try event.code (e.g. "F13")
  if (event.code && event.code !== "") return event.code;
  // 3. Fall back to keyCode → F13-F24 mapping
  const kc = event.keyCode;
  if (kc >= 124 && kc <= 135) return `F${kc - 111}`;
  // 4. Other high VK codes
  if (kc > 0) return `VK_${kc}`;
  return "Unknown";
}

function normalizeKeyName(key: string): string {
  return KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/* ─────────────────────────────────────────────────────────
   Condition Types
   ───────────────────────────────────────────────────────── */

const CONDITION_TYPE_KEYS: Array<{ value: ActionCondition["type"]; key: string }> = [
  { value: "windowTitleContains", key: "picker.conditionWindowTitleContains" },
  { value: "windowTitleNotContains", key: "picker.conditionWindowTitleNotContains" },
  { value: "exeEquals", key: "picker.conditionExeEquals" },
  { value: "exeNotEquals", key: "picker.conditionExeNotEquals" },
];

/* ─────────────────────────────────────────────────────────
   Sequence Step Editor (reusable)
   ───────────────────────────────────────────────────────── */

export function SequenceStepEditor({
  steps,
  onUpdate,
}: {
  steps: SequenceStep[];
  onUpdate: (steps: SequenceStep[]) => void;
}) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);

  // Capture keystrokes during recording and forward to Rust
  useEffect(() => {
    if (!isRecording) return;

    function handleRecordKey(e: KeyboardEvent) {
      // Ignore bare modifiers
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      const rawKey = resolveKeyName(e);
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      const keyName = normalizeKeyName(rawKey);
      parts.push(keyName);
      const formatted = parts.join("+");

      void recordKeystroke(formatted);
    }

    window.addEventListener("keydown", handleRecordKey, true);
    return () => window.removeEventListener("keydown", handleRecordKey, true);
  }, [isRecording]);

  async function handleStartRecording() {
    try {
      await startMacroRecording();
      setIsRecording(true);
    } catch {
      // Silently ignore — recorder might already be in use
    }
  }

  async function handleStopRecording() {
    try {
      const recording = await stopMacroRecording();
      setIsRecording(false);
      if (recording.steps.length > 0) {
        onUpdate(recording.steps);
      }
    } catch {
      setIsRecording(false);
    }
  }

  function addStep(type: SequenceStep["type"]) {
    onUpdate([...steps, createDefaultSequenceStep(type)]);
  }

  function removeStep(index: number) {
    if (steps.length <= 1) return;
    onUpdate(steps.filter((_, i) => i !== index));
  }

  function updateStep(index: number, next: SequenceStep) {
    onUpdate(steps.map((s, i) => (i === index ? next : s)));
  }

  return (
    <div className="editor-grid">
      <div className="field__header">
        <span className="field__label">{t("picker.sequenceSteps")}</span>
        <div className="editor-actions">
          {isRecording ? (
            <button
              type="button"
              className="action-button action-button--accent action-button--small"
              onClick={() => { void handleStopRecording(); }}
            >
              {t("picker.stopRecording")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => { void handleStartRecording(); }}
              >
                {t("picker.recordMacro")}
              </button>
              {(
                [
                  ["send", t("picker.addSend")],
                  ["text", t("picker.addText")],
                  ["sleep", t("picker.addSleep")],
                  ["launch", t("picker.addLaunch")],
                ] as Array<[SequenceStep["type"], string]>
              ).map(([stepType, label]) => (
                <button
                  type="button"
                  key={stepType}
                  className="action-button action-button--secondary action-button--small"
                  onClick={() => addStep(stepType)}
                >
                  + {label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {isRecording ? (
        <div className="notice notice--warning" style={{ marginBottom: 8 }}>
          <strong>{t("picker.recordingNotice")}</strong>
          <p>{t("picker.recordingHint")}</p>
        </div>
      ) : null}

      <div className="stack-list">
        {steps.map((step, index) => (
          <div className="compound-card" key={index}>
            <div className="compound-card__header">
              <div>
                <strong>{t("picker.stepTitle", { index: index + 1 })}</strong>
                <span className="compound-card__meta">{labelForSequenceStep(step.type)}</span>
              </div>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                disabled={steps.length === 1}
                onClick={() => removeStep(index)}
              >
                {t("common.delete")}
              </button>
            </div>

            <div className="editor-grid">
              <label className="field">
                <span className="field__label">{t("picker.stepType")}</span>
                <select
                  value={step.type}
                  onChange={(e) => updateStep(index, coerceSequenceStepType(step, e.target.value as SequenceStep["type"]))}
                >
                  <option value="send">{t("picker.stepSend")}</option>
                  <option value="text">{t("picker.stepText")}</option>
                  <option value="sleep">{t("picker.stepSleep")}</option>
                  <option value="launch">{t("picker.stepLaunch")}</option>
                </select>
              </label>

              {step.type !== "sleep" ? (
                <label className="field">
                  <span className="field__label">{t("picker.stepValue")}</span>
                  <input
                    type="text"
                    value={step.value}
                    onChange={(e) =>
                      updateStep(index, { ...step, value: e.target.value } as SequenceStep)
                    }
                  />
                </label>
              ) : null}

              <label className="field">
                <span className="field__label">{t("picker.stepDelay")}</span>
                <input
                  type="number"
                  min={0}
                  max={30000}
                  value={step.delayMs ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    const raw = v ? Number(v) : undefined;
                    const delay =
                      raw !== undefined && Number.isFinite(raw)
                        ? Math.max(0, Math.min(30000, Math.round(raw)))
                        : undefined;
                    updateStep(index, setSequenceStepDelay(step, delay));
                  }}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

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

  // Focus trap
  const handleFocusTrap = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const container = modalRef.current;
    if (!container) return;

    const focusable = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
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

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape" && !isCapturing && !isCapturingSignal) onCancel();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onCancel, isCapturing, isCapturingSignal]);

  // Draft action state per category
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutActionPayload>(() =>
    existingAction?.type === "shortcut"
      ? existingAction.payload
      : { key: "", ctrl: false, shift: false, alt: false, win: false },
  );
  const [mouseDraft, setMouseDraft] = useState<{
    action: MouseActionKind;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    win: boolean;
  }>(() =>
    existingAction?.type === "mouseAction"
      ? {
          action: existingAction.payload.action,
          ctrl: existingAction.payload.ctrl ?? false,
          shift: existingAction.payload.shift ?? false,
          alt: existingAction.payload.alt ?? false,
          win: existingAction.payload.win ?? false,
        }
      : { action: "leftClick", ctrl: false, shift: false, alt: false, win: false },
  );
  const [textDraft, setTextDraft] = useState<{ text: string; pasteMode: PasteMode }>(() =>
    existingAction?.type === "textSnippet" && existingAction.payload.source === "inline"
      ? { text: existingAction.payload.text, pasteMode: existingAction.payload.pasteMode }
      : { text: "", pasteMode: "sendText" },
  );
  const [launchDraft, setLaunchDraft] = useState<{ target: string; args: string }>(() =>
    existingAction?.type === "launch"
      ? { target: existingAction.payload.target, args: existingAction.payload.args?.join(" ") ?? "" }
      : { target: "", args: "" },
  );
  const [mediaDraft, setMediaDraft] = useState<MediaKeyKind>(() =>
    existingAction?.type === "mediaKey"
      ? existingAction.payload.key
      : "playPause",
  );
  const [profileDraft, setProfileDraft] = useState<string>(() =>
    existingAction?.type === "profileSwitch"
      ? existingAction.payload.targetProfileId
      : config.profiles[0]?.id ?? "",
  );
  const [sequenceDraft, setSequenceDraft] = useState<SequenceStep[]>(() =>
    existingAction?.type === "sequence"
      ? existingAction.payload.steps
      : [{ type: "send", value: "Ctrl+C" }],
  );
  const [nameDraft, setNameDraft] = useState(() =>
    existingAction?.pretty ?? "",
  );
  const [triggerModeDraft, setTriggerModeDraft] = useState<TriggerMode>(
    () => binding?.triggerMode ?? "press",
  );
  const [chordPartnerDraft, setChordPartnerDraft] = useState<string>(
    () => binding?.chordPartner ?? "",
  );
  const [conditionsDraft, setConditionsDraft] = useState<ActionCondition[]>(
    () => existingAction?.conditions ?? [],
  );

  function handleKeyCapture(event: React.KeyboardEvent) {
    if (!isCapturing) return;
    event.preventDefault();
    event.stopPropagation();

    const key = resolveKeyName(event);
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;

    setShortcutDraft({
      key: normalizeKeyName(key),
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      win: event.metaKey,
    });
    setIsCapturing(false);
  }

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

  function buildAction(): Action {
    const category = ACTION_CATEGORIES.find((c) => c.id === effectiveCategory) ?? ACTION_CATEGORIES[0];
    const actionType = category.actionType;
    const actionId = existingAction?.id ?? `action-picker-${Date.now()}`;
    const pretty = nameDraft.trim() || autoName(actionType);
    const validConditions = conditionsDraft.filter((c) => c.value.trim());

    const base: Action = (() => {
      switch (actionType) {
        case "shortcut":
          return { id: actionId, type: "shortcut" as const, payload: shortcutDraft, pretty };
        case "mouseAction":
          return {
            id: actionId,
            type: "mouseAction" as const,
            payload: {
              action: mouseDraft.action,
              ...(mouseDraft.ctrl && { ctrl: true }),
              ...(mouseDraft.shift && { shift: true }),
              ...(mouseDraft.alt && { alt: true }),
              ...(mouseDraft.win && { win: true }),
            },
            pretty,
          };
        case "textSnippet":
          return {
            id: actionId,
            type: "textSnippet" as const,
            payload: { source: "inline" as const, text: textDraft.text, pasteMode: textDraft.pasteMode, tags: [] },
            pretty,
          };
        case "sequence":
          return { id: actionId, type: "sequence" as const, payload: { steps: sequenceDraft }, pretty };
        case "launch":
          return {
            id: actionId,
            type: "launch" as const,
            payload: { target: launchDraft.target, args: launchDraft.args.trim() ? launchDraft.args.trim().split(/\s+/) : undefined },
            pretty,
          };
        case "mediaKey":
          return { id: actionId, type: "mediaKey" as const, payload: { key: mediaDraft }, pretty };
        case "profileSwitch":
          return { id: actionId, type: "profileSwitch" as const, payload: { targetProfileId: profileDraft }, pretty };
        case "menu":
          return { id: actionId, type: "menu" as const, payload: { items: [] }, pretty: pretty || t("picker.defaultMenu") };
        case "disabled":
          return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, pretty: pretty || t("picker.defaultDisabled") };
        default:
          return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, pretty: t("picker.defaultDisabled") };
      }
    })();

    return validConditions.length > 0 ? { ...base, conditions: validConditions } : base;
  }

  function autoName(actionType: ActionType): string {
    switch (actionType) {
      case "shortcut": {
        const parts = [
          shortcutDraft.ctrl ? "Ctrl" : null,
          shortcutDraft.shift ? "Shift" : null,
          shortcutDraft.alt ? "Alt" : null,
          shortcutDraft.win ? "Win" : null,
          shortcutDraft.key || null,
        ].filter(Boolean);
        return parts.length > 0 ? parts.join(" + ") : t("picker.autoShortcut");
      }
      case "mouseAction": {
        const mods = [
          mouseDraft.ctrl ? "Ctrl" : null,
          mouseDraft.shift ? "Shift" : null,
          mouseDraft.alt ? "Alt" : null,
          mouseDraft.win ? "Win" : null,
        ].filter(Boolean);
        const actionLabel = MOUSE_ACTION_OPTIONS.find((o) => o.value === mouseDraft.action)?.label ?? t("picker.autoMouse");
        return mods.length > 0 ? `${mods.join(" + ")} + ${actionLabel}` : actionLabel;
      }
      case "textSnippet":
        return textDraft.text.slice(0, 30) || t("picker.autoText");
      case "sequence":
        return t("picker.autoMacro");
      case "launch":
        return launchDraft.target.split(/[/\\]/).pop() ?? t("sequence.launch");
      case "mediaKey":
        return MEDIA_KEY_OPTIONS.find((o) => o.value === mediaDraft)?.label ?? t("action.type.mediaKey");
      case "profileSwitch": {
        const p = config.profiles.find((pr) => pr.id === profileDraft);
        return p ? t("picker.autoProfile", { name: p.name }) : t("picker.autoProfileFallback");
      }
      case "menu":
        return t("picker.defaultMenu");
      case "disabled":
        return t("picker.defaultDisabled");
      default:
        return t("picker.defaultAction");
    }
  }

  function handleSave() {
    const nextAction = buildAction();
    let nextConfig = upsertAction(config, nextAction);

    if (binding) {
      nextConfig = upsertBinding(nextConfig, {
        ...binding,
        actionRef: nextAction.id,
        label: nextAction.pretty,
        enabled: true,
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

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal action-picker" ref={modalRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={handleFocusTrap}>
        <div className="action-picker__header">
          <div>
            <h2>{t("picker.title")}</h2>
            {controlLabel ? (
              <p className="action-picker__subtitle">{controlLabel}{layerLabel ? ` · ${layerLabel}` : ""}</p>
            ) : null}
          </div>
          <button type="button" className="action-picker__close" onClick={onCancel}>×</button>
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
              <div className="editor-grid" onKeyDown={handleKeyCapture}>
                <label className="field">
                  <span className="field__label">{t("picker.keyLabel")}</span>
                  <div className="capture-row">
                    <input
                      type="text"
                      readOnly
                      value={shortcutDraft.key}
                      placeholder={isCapturing ? t("picker.keyCapturing") : t("picker.keyEmpty")}
                      className={isCapturing ? "capture-active" : ""}
                    />
                    <button
                      type="button"
                      className={`action-button${isCapturing ? " action-button--accent" : ""}`}
                      onClick={() => setIsCapturing(!isCapturing)}
                    >
                      {isCapturing ? t("common.cancel") : t("picker.record")}
                    </button>
                  </div>
                </label>
                <div className="modifier-row">
                  {(["ctrl", "shift", "alt", "win"] as const).map((mod) => (
                    <label key={mod} className="field field--inline">
                      <Toggle
                        checked={shortcutDraft[mod]}
                        onChange={(checked) => setShortcutDraft({ ...shortcutDraft, [mod]: checked })}
                        ariaLabel={mod.charAt(0).toUpperCase() + mod.slice(1)}
                      />
                      <span className="field__label">{mod.charAt(0).toUpperCase() + mod.slice(1)}</span>
                    </label>
                  ))}
                </div>
                <p className="panel__muted">
                  {t("picker.modifiersHint")}
                </p>
              </div>
            ) : null}

            {effectiveCategory === "mouseAction" ? (
              <div className="editor-grid">
                <div className="picker-grid">
                  {MOUSE_ACTION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`picker-grid__btn${mouseDraft.action === opt.value ? " picker-grid__btn--active" : ""}`}
                      onClick={() => setMouseDraft({ ...mouseDraft, action: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="modifier-row">
                  {(["ctrl", "shift", "alt", "win"] as const).map((mod) => (
                    <label key={mod} className="field field--inline">
                      <Toggle
                        checked={mouseDraft[mod]}
                        onChange={(checked) => setMouseDraft({ ...mouseDraft, [mod]: checked })}
                        ariaLabel={mod.charAt(0).toUpperCase() + mod.slice(1)}
                      />
                      <span className="field__label">{mod.charAt(0).toUpperCase() + mod.slice(1)}</span>
                    </label>
                  ))}
                </div>
                <p className="panel__muted">
                  {t("picker.mouseModifiersHint")}
                </p>
              </div>
            ) : null}

            {effectiveCategory === "textSnippet" ? (
              <div className="editor-grid">
                <label className="field">
                  <span className="field__label">{t("picker.textLabel")}</span>
                  <textarea
                    rows={4}
                    value={textDraft.text}
                    onChange={(e) => setTextDraft({ ...textDraft, text: e.target.value })}
                    placeholder={t("picker.textPlaceholder")}
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t("picker.inputMethod")}</span>
                  <select
                    value={textDraft.pasteMode}
                    onChange={(e) => setTextDraft({ ...textDraft, pasteMode: e.target.value as PasteMode })}
                  >
                    <option value="clipboardPaste">{t("picker.inputClipboard")}</option>
                    <option value="sendText">{t("picker.inputDirect")}</option>
                  </select>
                </label>
              </div>
            ) : null}

            {effectiveCategory === "sequence" ? (
              <SequenceStepEditor
                steps={sequenceDraft}
                onUpdate={setSequenceDraft}
              />
            ) : null}

            {effectiveCategory === "launch" ? (
              <div className="editor-grid">
                <label className="field">
                  <span className="field__label">{t("picker.programLabel")}</span>
                  <input
                    type="text"
                    value={launchDraft.target}
                    onChange={(e) => setLaunchDraft({ ...launchDraft, target: e.target.value })}
                    placeholder="C:\Program Files\app.exe"
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t("picker.argumentsLabel")}</span>
                  <input
                    type="text"
                    value={launchDraft.args}
                    onChange={(e) => setLaunchDraft({ ...launchDraft, args: e.target.value })}
                    placeholder="--flag value"
                  />
                </label>
              </div>
            ) : null}

            {effectiveCategory === "mediaKey" ? (
              <div className="editor-grid">
                <div className="picker-grid">
                  {MEDIA_KEY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`picker-grid__btn${mediaDraft === opt.value ? " picker-grid__btn--active" : ""}`}
                      onClick={() => setMediaDraft(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {effectiveCategory === "profileSwitch" ? (
              <div className="editor-grid">
                <label className="field">
                  <span className="field__label">{t("picker.switchProfile")}</span>
                  <select
                    value={profileDraft}
                    onChange={(e) => setProfileDraft(e.target.value)}
                  >
                    {config.profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {effectiveCategory === "disabled" ? (
              <div className="editor-grid">
                <p className="panel__muted">
                  {t("picker.disabledHint")}
                </p>
              </div>
            ) : null}

            {controlId && selectedLayer ? (
              <div className="editor-grid mt-12">
                <label className="field">
                  <span className="field__label">
                    {t("picker.signalLabel")}
                    {expectedSignal ? (
                      <span className="field__hint" title={`${t("picker.signalRecommended")} ${expectedSignal}`}>
                        ?
                      </span>
                    ) : null}
                  </span>
                  <div className="capture-row">
                    <input
                      type="text"
                      readOnly
                      value={signalDraft ?? ""}
                      placeholder={isCapturingSignal ? t("picker.signalCapturing") : t("picker.signalEmpty")}
                      className={isCapturingSignal ? "capture-active" : ""}
                    />
                    <button
                      type="button"
                      className={`action-button${isCapturingSignal ? " action-button--accent" : ""}`}
                      onClick={() => setIsCapturingSignal(!isCapturingSignal)}
                    >
                      {isCapturingSignal ? t("common.cancel") : t("picker.record")}
                    </button>
                  </div>
                  {isCapturingSignal ? (
                    <p className="panel__muted">{t("picker.signalCaptureHint")}</p>
                  ) : null}
                </label>
                {expectedSignal && signalDraft !== expectedSignal ? (
                  <p className="panel__muted">
                    {t("picker.signalRecommended")} <code>{expectedSignal}</code>{" "}
                    <button
                      type="button"
                      className="action-button action-button--small action-button--ghost"
                      onClick={() => setSignalDraft(expectedSignal)}
                    >
                      {t("picker.signalApply")}
                    </button>
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className="field mt-12">
              <span className="field__label">{t("picker.nameLabel")}</span>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={autoName(ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.actionType ?? "disabled")}
              />
            </label>

            <div className="editor-grid mt-12">
              <div className="field__header">
                <span className="field__label">{t("picker.conditionsLabel")}</span>
                <button
                  type="button"
                  className="action-button action-button--secondary action-button--small"
                  onClick={() =>
                    setConditionsDraft([
                      ...conditionsDraft,
                      { type: "windowTitleContains", value: "" },
                    ])
                  }
                >
                  {t("picker.conditionsAdd")}
                </button>
              </div>

              {conditionsDraft.length === 0 ? (
                <p className="panel__muted">
                  {t("picker.conditionsEmpty")}
                </p>
              ) : (
                <div className="stack-list">
                  {conditionsDraft.map((condition, index) => (
                    <div className="compound-card" key={index}>
                      <div className="compound-card__header">
                        <strong>{t("picker.conditionTitle", { index: index + 1 })}</strong>
                        <button
                          type="button"
                          className="action-button action-button--secondary action-button--small"
                          onClick={() =>
                            setConditionsDraft(conditionsDraft.filter((_, i) => i !== index))
                          }
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                      <div className="editor-grid">
                        <label className="field">
                          <span className="field__label">{t("picker.conditionType")}</span>
                          <select
                            value={condition.type}
                            onChange={(e) => {
                              const nextType = e.target.value as ActionCondition["type"];
                              setConditionsDraft(
                                conditionsDraft.map((c, i) =>
                                  i === index ? { type: nextType, value: c.value } : c,
                                ),
                              );
                            }}
                          >
                            {CONDITION_TYPE_KEYS.map((ct) => (
                              <option key={ct.value} value={ct.value}>
                                {t(ct.key)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span className="field__label">{t("picker.conditionValue")}</span>
                          <input
                            type="text"
                            value={condition.value}
                            placeholder={
                              condition.type.startsWith("exe")
                                ? t("picker.conditionPlaceholderExe")
                                : t("picker.conditionPlaceholderTitle")
                            }
                            onChange={(e) =>
                              setConditionsDraft(
                                conditionsDraft.map((c, i) =>
                                  i === index ? { ...c, value: e.target.value } : c,
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                  <p className="panel__muted">
                    {t("picker.conditionsAllRequired")}
                  </p>
                </div>
              )}
            </div>

            <label className="field mt-12">
              <span className="field__label">{t("picker.triggerMode")}</span>
              <select
                value={triggerModeDraft}
                onChange={(e) => setTriggerModeDraft(e.target.value as TriggerMode)}
              >
                <option value="press">{t("picker.triggerPress")}</option>
                <option value="doublePress">{t("picker.triggerDoublePress")}</option>
                <option value="triplePress">{t("picker.triggerTriplePress")}</option>
                <option value="hold">{t("picker.triggerHold")}</option>
                <option value="chord">{t("picker.triggerChord")}</option>
              </select>
            </label>

            {triggerModeDraft === "chord" && controlId ? (
              <div className="field">
                <p className="panel__muted" style={{ margin: "4px 0", fontSize: "0.76rem" }}>
                  {t("picker.chordExplainer")}
                </p>
                <div className="chord-preview">
                  <span className="chord-preview__key">
                    {config.physicalControls.find((c) => c.id === controlId)?.defaultName ?? controlId}
                  </span>
                  <span className="chord-preview__plus">+</span>
                  <span className="chord-preview__key chord-preview__key--partner">
                    {config.physicalControls.find((c) => c.id === chordPartnerDraft)?.defaultName ?? "…"}
                  </span>
                </div>
                <label className="field">
                  <span className="field__label">{t("picker.chordPartner")}</span>
                  <select
                    value={chordPartnerDraft}
                    onChange={(e) => setChordPartnerDraft(e.target.value as ControlId)}
                  >
                    <option value="">{t("picker.chordPartnerEmpty")}</option>
                    {config.physicalControls
                      .filter((c) => c.id !== controlId && c.remappable)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.defaultName}
                        </option>
                      ))}
                  </select>
                </label>
                {chordPartnerDraft && selectedLayer ? (
                  (() => {
                    const partnerHasChord = config.bindings.some(
                      (b) =>
                        b.controlId === chordPartnerDraft &&
                        b.layer === selectedLayer &&
                        b.triggerMode === "chord" &&
                        b.enabled,
                    );
                    return partnerHasChord ? null : (
                      <p className="notice notice--warning" style={{ margin: 0, fontSize: "0.76rem" }}>
                        {t("picker.chordWarnNoPartnerBinding")}
                      </p>
                    );
                  })()
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="action-picker__footer">
          <button type="button" className="action-button action-button--ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="action-button action-button--primary"
            onClick={handleSave}
            disabled={effectiveCategory === "shortcut" && !shortcutDraft.key && !shortcutDraft.ctrl && !shortcutDraft.shift && !shortcutDraft.alt && !shortcutDraft.win}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
