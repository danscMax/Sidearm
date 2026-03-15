import { useEffect, useRef, useCallback, useState } from "react";
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

const CONDITION_TYPES: Array<{ value: ActionCondition["type"]; label: string }> = [
  { value: "windowTitleContains", label: "Заголовок окна содержит" },
  { value: "windowTitleNotContains", label: "Заголовок окна НЕ содержит" },
  { value: "exeEquals", label: "Процесс равен" },
  { value: "exeNotEquals", label: "Процесс НЕ равен" },
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
        <span className="field__label">Шаги последовательности</span>
        <div className="editor-actions">
          {isRecording ? (
            <button
              type="button"
              className="action-button action-button--accent action-button--small"
              onClick={() => { void handleStopRecording(); }}
            >
              ⏹ Остановить запись
            </button>
          ) : (
            <>
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => { void handleStartRecording(); }}
              >
                ⏺ Записать
              </button>
              {(
                [
                  ["send", "Отправка"],
                  ["text", "Текст"],
                  ["sleep", "Пауза"],
                  ["launch", "Запуск"],
                ] as const
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
          <strong>⏺ Запись макроса...</strong>
          <p>Нажимайте клавиши. Каждое нажатие будет записано как шаг последовательности.</p>
        </div>
      ) : null}

      <div className="stack-list">
        {steps.map((step, index) => (
          <div className="compound-card" key={index}>
            <div className="compound-card__header">
              <div>
                <strong>Шаг {index + 1}</strong>
                <span className="compound-card__meta">{labelForSequenceStep(step.type)}</span>
              </div>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                disabled={steps.length === 1}
                onClick={() => removeStep(index)}
              >
                Удалить
              </button>
            </div>

            <div className="editor-grid">
              <label className="field">
                <span className="field__label">Тип</span>
                <select
                  value={step.type}
                  onChange={(e) => updateStep(index, coerceSequenceStepType(step, e.target.value as SequenceStep["type"]))}
                >
                  <option value="send">Отправка сочетания</option>
                  <option value="text">Ввод текста</option>
                  <option value="sleep">Пауза</option>
                  <option value="launch">Запуск</option>
                </select>
              </label>

              {step.type !== "sleep" ? (
                <label className="field">
                  <span className="field__label">Значение</span>
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
                <span className="field__label">Задержка (мс, макс. 30 000)</span>
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
      : { text: "", pasteMode: "clipboardPaste" },
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
          return { id: actionId, type: "menu" as const, payload: { items: [] }, pretty: pretty || "Меню" };
        case "disabled":
          return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, pretty: pretty || "Отключено" };
        default:
          return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, pretty: "Отключено" };
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
        return parts.length > 0 ? parts.join(" + ") : "Шорткат";
      }
      case "mouseAction": {
        const mods = [
          mouseDraft.ctrl ? "Ctrl" : null,
          mouseDraft.shift ? "Shift" : null,
          mouseDraft.alt ? "Alt" : null,
          mouseDraft.win ? "Win" : null,
        ].filter(Boolean);
        const actionLabel = MOUSE_ACTION_OPTIONS.find((o) => o.value === mouseDraft.action)?.label ?? "Мышь";
        return mods.length > 0 ? `${mods.join(" + ")} + ${actionLabel}` : actionLabel;
      }
      case "textSnippet":
        return textDraft.text.slice(0, 30) || "Текст";
      case "sequence":
        return "Макрос";
      case "launch":
        return launchDraft.target.split(/[/\\]/).pop() ?? "Запуск";
      case "mediaKey":
        return MEDIA_KEY_OPTIONS.find((o) => o.value === mediaDraft)?.label ?? "Медиа";
      case "profileSwitch": {
        const p = config.profiles.find((pr) => pr.id === profileDraft);
        return p ? `Профиль: ${p.name}` : "Профиль";
      }
      case "menu":
        return "Меню";
      case "disabled":
        return "Отключено";
      default:
        return "Действие";
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
            <h2>Назначить действие</h2>
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
              placeholder="Поиск действия..."
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
                  <span className="field__label">Клавиша</span>
                  <div className="capture-row">
                    <input
                      type="text"
                      readOnly
                      value={shortcutDraft.key}
                      placeholder={isCapturing ? "Нажмите клавишу..." : "Не задана"}
                      className={isCapturing ? "capture-active" : ""}
                    />
                    <button
                      type="button"
                      className={`action-button${isCapturing ? " action-button--accent" : ""}`}
                      onClick={() => setIsCapturing(!isCapturing)}
                    >
                      {isCapturing ? "Отмена" : "Записать"}
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
                  Можно оставить поле клавиши пустым и назначить только Ctrl, Alt, Shift, Win или их сочетание.
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
                  Модификаторы зажимаются на время действия. Например, Ctrl + Скролл вверх = зум.
                </p>
              </div>
            ) : null}

            {effectiveCategory === "textSnippet" ? (
              <div className="editor-grid">
                <label className="field">
                  <span className="field__label">Текст</span>
                  <textarea
                    rows={4}
                    value={textDraft.text}
                    onChange={(e) => setTextDraft({ ...textDraft, text: e.target.value })}
                    placeholder="Введите текст для ввода..."
                  />
                </label>
                <label className="field">
                  <span className="field__label">Способ ввода</span>
                  <select
                    value={textDraft.pasteMode}
                    onChange={(e) => setTextDraft({ ...textDraft, pasteMode: e.target.value as PasteMode })}
                  >
                    <option value="clipboardPaste">Через буфер обмена</option>
                    <option value="sendText">Посимвольный ввод</option>
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
                  <span className="field__label">Программа</span>
                  <input
                    type="text"
                    value={launchDraft.target}
                    onChange={(e) => setLaunchDraft({ ...launchDraft, target: e.target.value })}
                    placeholder="C:\Program Files\программа.exe"
                  />
                </label>
                <label className="field">
                  <span className="field__label">Аргументы</span>
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
                  <span className="field__label">Переключить на профиль</span>
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
                  Кнопка будет отключена — нажатие не вызовет никакого действия.
                </p>
              </div>
            ) : null}

            {controlId && selectedLayer ? (
              <div className="editor-grid mt-12">
                <label className="field">
                  <span className="field__label">
                    Сигнал кнопки
                    {expectedSignal ? (
                      <span className="field__hint" title={`Рекомендуемый сигнал: ${expectedSignal}`}>
                        ?
                      </span>
                    ) : null}
                  </span>
                  <div className="capture-row">
                    <input
                      type="text"
                      readOnly
                      value={signalDraft ?? ""}
                      placeholder={isCapturingSignal ? "Нажмите кнопку на мыши..." : "Не задан"}
                      className={isCapturingSignal ? "capture-active" : ""}
                    />
                    <button
                      type="button"
                      className={`action-button${isCapturingSignal ? " action-button--accent" : ""}`}
                      onClick={() => setIsCapturingSignal(!isCapturingSignal)}
                    >
                      {isCapturingSignal ? "Отмена" : "Записать"}
                    </button>
                  </div>
                  {isCapturingSignal ? (
                    <p className="panel__muted">Нажмите кнопку на мыши. Перехват должен быть запущен.</p>
                  ) : null}
                </label>
                {expectedSignal && signalDraft !== expectedSignal ? (
                  <p className="panel__muted">
                    Рекомендуемый: <code>{expectedSignal}</code>{" "}
                    <button
                      type="button"
                      className="action-button action-button--small action-button--ghost"
                      onClick={() => setSignalDraft(expectedSignal)}
                    >
                      Применить
                    </button>
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className="field mt-12">
              <span className="field__label">Название</span>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={autoName(ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.actionType ?? "disabled")}
              />
            </label>

            <div className="editor-grid mt-12">
              <div className="field__header">
                <span className="field__label">Условия выполнения</span>
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
                  + Добавить
                </button>
              </div>

              {conditionsDraft.length === 0 ? (
                <p className="panel__muted">
                  Без условий — действие выполняется всегда.
                </p>
              ) : (
                <div className="stack-list">
                  {conditionsDraft.map((condition, index) => (
                    <div className="compound-card" key={index}>
                      <div className="compound-card__header">
                        <strong>Условие {index + 1}</strong>
                        <button
                          type="button"
                          className="action-button action-button--secondary action-button--small"
                          onClick={() =>
                            setConditionsDraft(conditionsDraft.filter((_, i) => i !== index))
                          }
                        >
                          Удалить
                        </button>
                      </div>
                      <div className="editor-grid">
                        <label className="field">
                          <span className="field__label">Тип</span>
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
                            {CONDITION_TYPES.map((ct) => (
                              <option key={ct.value} value={ct.value}>
                                {ct.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span className="field__label">Значение</span>
                          <input
                            type="text"
                            value={condition.value}
                            placeholder={
                              condition.type.startsWith("exe")
                                ? "chrome.exe"
                                : "часть заголовка"
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
                    Все условия должны выполняться одновременно (логика «И»).
                  </p>
                </div>
              )}
            </div>

            <label className="field mt-12">
              <span className="field__label">Режим срабатывания</span>
              <select
                value={triggerModeDraft}
                onChange={(e) => setTriggerModeDraft(e.target.value as TriggerMode)}
              >
                <option value="press">Нажатие</option>
                <option value="hold">Удержание</option>
                <option value="chord">Аккорд (две кнопки)</option>
              </select>
            </label>

            {triggerModeDraft === "chord" && controlId ? (
              <label className="field">
                <span className="field__label">Вторая кнопка аккорда</span>
                <select
                  value={chordPartnerDraft}
                  onChange={(e) => setChordPartnerDraft(e.target.value as ControlId)}
                >
                  <option value="">Выберите кнопку...</option>
                  {config.physicalControls
                    .filter((c) => c.id !== controlId && c.remappable)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.defaultName}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        <div className="action-picker__footer">
          <button type="button" className="action-button action-button--ghost" onClick={onCancel}>
            Отмена
          </button>
          <button
            type="button"
            className="action-button action-button--primary"
            onClick={handleSave}
            disabled={effectiveCategory === "shortcut" && !shortcutDraft.key && !shortcutDraft.ctrl && !shortcutDraft.shift && !shortcutDraft.alt && !shortcutDraft.win}
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
