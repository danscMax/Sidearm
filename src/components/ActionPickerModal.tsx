import { useEffect, useRef, useCallback, useState } from "react";
import type {
  Action,
  ActionType,
  AppConfig,
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
import {
  coerceSequenceStepType,
  createDefaultSequenceStep,
  labelForSequenceStep,
  setSequenceStepDelay,
} from "../lib/helpers";
import { upsertAction, upsertBinding } from "../lib/config-editing";

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

function normalizeKeyName(key: string): string {
  return KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

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
        </div>
      </div>

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
  onSave,
  onCancel,
}: {
  config: AppConfig;
  bindingId: string | null;
  controlLabel?: string;
  layerLabel?: string;
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
      if (e.key === "Escape" && !isCapturing) onCancel();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onCancel, isCapturing]);

  // Draft action state per category
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutActionPayload>(() =>
    existingAction?.type === "shortcut"
      ? existingAction.payload
      : { key: "", ctrl: false, shift: false, alt: false, win: false },
  );
  const [mouseDraft, setMouseDraft] = useState<MouseActionKind>(() =>
    existingAction?.type === "mouseAction"
      ? existingAction.payload.action
      : "leftClick",
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

  function handleKeyCapture(event: React.KeyboardEvent) {
    if (!isCapturing) return;
    event.preventDefault();
    event.stopPropagation();

    const key = event.key;
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

  function buildAction(): Action {
    const category = ACTION_CATEGORIES.find((c) => c.id === effectiveCategory) ?? ACTION_CATEGORIES[0];
    const actionType = category.actionType;
    const actionId = existingAction?.id ?? `action-picker-${Date.now()}`;
    const pretty = nameDraft.trim() || autoName(actionType);

    switch (actionType) {
      case "shortcut":
        return { id: actionId, type: "shortcut", payload: shortcutDraft, pretty };
      case "mouseAction":
        return { id: actionId, type: "mouseAction", payload: { action: mouseDraft }, pretty };
      case "textSnippet":
        return {
          id: actionId,
          type: "textSnippet",
          payload: { source: "inline", text: textDraft.text, pasteMode: textDraft.pasteMode, tags: [] },
          pretty,
        };
      case "sequence":
        return { id: actionId, type: "sequence", payload: { steps: sequenceDraft }, pretty };
      case "launch":
        return {
          id: actionId,
          type: "launch",
          payload: { target: launchDraft.target, args: launchDraft.args.trim() ? launchDraft.args.trim().split(/\s+/) : undefined },
          pretty,
        };
      case "mediaKey":
        return { id: actionId, type: "mediaKey", payload: { key: mediaDraft }, pretty };
      case "profileSwitch":
        return { id: actionId, type: "profileSwitch", payload: { targetProfileId: profileDraft }, pretty };
      case "menu":
        return { id: actionId, type: "menu", payload: { items: [] }, pretty: pretty || "Меню" };
      case "disabled":
        return { id: actionId, type: "disabled", payload: {} as Record<string, never>, pretty: pretty || "Отключено" };
      default:
        return { id: actionId, type: "disabled", payload: {} as Record<string, never>, pretty: "Отключено" };
    }
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
      case "mouseAction":
        return MOUSE_ACTION_OPTIONS.find((o) => o.value === mouseDraft)?.label ?? "Мышь";
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
                      <input
                        type="checkbox"
                        checked={shortcutDraft[mod]}
                        onChange={(e) => setShortcutDraft({ ...shortcutDraft, [mod]: e.target.checked })}
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
                      className={`picker-grid__btn${mouseDraft === opt.value ? " picker-grid__btn--active" : ""}`}
                      onClick={() => setMouseDraft(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
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

            <label className="field mt-12">
              <span className="field__label">Название</span>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={autoName(ACTION_CATEGORIES.find((c) => c.id === effectiveCategory)?.actionType ?? "disabled")}
              />
            </label>

            {effectiveCategory === "shortcut" ? (
              <label className="field mt-12">
                <span className="field__label">Режим срабатывания</span>
                <select
                  value={triggerModeDraft}
                  onChange={(e) => setTriggerModeDraft(e.target.value as TriggerMode)}
                >
                  <option value="press">Нажатие</option>
                  <option value="hold">Удержание</option>
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
