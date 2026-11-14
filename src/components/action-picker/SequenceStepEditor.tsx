import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_SEQUENCE_STEPS, type SequenceStep } from "../../lib/config";
import { Notice, SelectField } from "../shared";
import {
  coerceSequenceStepType,
  createDefaultSequenceStep,
  modifierLabels,
  setSequenceStepDelay,
  swapItems,
} from "../../lib/action-helpers";
import { labelForSequenceStep } from "../../lib/labels";
import { normalizeKeyName, resolveKeyName } from "../../lib/action-picker-helpers";
import {
  normalizeCommandError,
  recordKeystroke,
  startMacroRecording,
  stopMacroRecording,
  type MacroRecording,
} from "../../lib/backend";
import { ChipEditor } from "../ChipEditor";
import { ExecutablePathField } from "../ExecutablePathField";
import { DirectoryPathField } from "../DirectoryPathField";
import { CategoryIcon } from "../icons";
import { acquireKeyRecording } from "./shared/key-recording";

// The backend recorder is shared by editor instances, including pending teardown.
let recordingCleanup: Promise<unknown> = Promise.resolve();

interface RecordingSession {
  cancelled: boolean;
  started: boolean;
  count: number;
  /** Steps it may still add: the macro's room when it started. */
  limit: number;
  /** The step it records after (its key), or the end. */
  after: string | null;
  start: Promise<void>;
  pending: Promise<void>;
  keyRecording?: ReturnType<typeof acquireKeyRecording>;
  stop?: Promise<MacroRecording | undefined>;
}

/** The chord a keydown makes, as the recorder and the Send field store it;
 *  null for a bare modifier and Sidearm's own mask key (VK_232). */
function chordOf(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const rawKey = resolveKeyName(e);
  if (rawKey === "VK_232") return null;
  // Canonical Ctrl→Shift→Alt→Win order via the shared modifierLabels helper,
  // so recorded chords match the rest of the UI.
  const mods = modifierLabels({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, win: e.metaKey });
  return [...mods, normalizeKeyName(rawKey)].join("+");
}

/** The character a printable key typed in the active layout (Shift and AltGr
 *  included); undefined for a chord or a special key. */
function typedText(e: KeyboardEvent): string | undefined {
  const altGr = e.getModifierState?.("AltGraph") ?? false;
  if (e.metaKey || ((e.ctrlKey || e.altKey) && !altGr)) return undefined;
  return [...e.key].length === 1 ? e.key : undefined;
}

/** The waits a macro has, in ms: `fixed` always; `windows` at most, while
 *  its "wait for window" steps wait up to their timeout. Typing time is not counted. */
function sequenceWaits(steps: SequenceStep[]): { fixed: number; windows: number } {
  let fixed = 0;
  let windows = 0;
  for (const step of steps) {
    if (step.type === "waitWindow") windows += step.timeoutMs;
    else if (step.type === "send" || step.type === "text") {
      // The executor waits after every repeat (repeat 0 skips the step, at most 100).
      fixed += (step.delayMs ?? 0) * Math.min(100, Math.max(0, step.repeat ?? 1));
    } else fixed += step.delayMs ?? 0;
  }
  return { fixed, windows };
}

function finishRecording(session: RecordingSession): Promise<MacroRecording | undefined> {
  if (!session.stop) {
    session.stop = (async () => {
      try {
        await session.start;
        await session.pending;
        if (session.started) return await stopMacroRecording();
      } finally {
        await session.keyRecording?.release();
      }
    })();
    recordingCleanup = session.stop.catch(() => {});
  }
  return session.stop;
}

export function SequenceStepEditor({
  steps,
  onChange,
}: {
  steps: SequenceStep[];
  onChange: (steps: SequenceStep[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [limitReached, setLimitReached] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const recordingRef = useRef<RecordingSession | null>(null);
  // The step shown open (its key): new and recorded steps go in after it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // A step just added: scrolled into view once it is drawn.
  const revealKey = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [dropAt, setDropAt] = useState<number | null>(null);
  // The recorder's stop runs from a listener set up at its start: it reads the steps now.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  useEffect(() => {
    const key = revealKey.current;
    if (!key) return;
    revealKey.current = null;
    rowRefs.current.get(key)?.scrollIntoView?.({ block: "nearest" });
  });

  useEffect(() => () => {
    const session = recordingRef.current;
    if (!session) return;
    session.cancelled = true;
    void finishRecording(session).catch(() => {});
  }, []);

  // Stable per-step keys decoupled from array index. SequenceStep is a
  // persisted/serialized type, so we can't add an id field to it; instead we
  // keep a parallel id list positionally in sync with `steps`. Without this,
  // key={index} makes React reconcile controlled <input>s by position, so
  // deleting/reordering a middle step visually moves focus/caret to a neighbour.
  const stepKeysRef = useRef<string[]>([]);
  function newStepKey(): string {
    return crypto.randomUUID();
  }
  // Reconcile the key list to the current step count (initial mount, or the
  // steps replaced from outside, e.g. an undo).
  if (stepKeysRef.current.length < steps.length) {
    while (stepKeysRef.current.length < steps.length) {
      stepKeysRef.current.push(newStepKey());
    }
  } else if (stepKeysRef.current.length > steps.length) {
    stepKeysRef.current.length = steps.length;
  }
  const stepKeys = stepKeysRef.current;
  const hasLaunchBeforeLaterStep = steps.some(
    (step, index) => step.type === "launch" && index < steps.length - 1,
  );

  // Capture keystrokes during recording and forward to Rust
  useEffect(() => {
    if (!isRecording) return;

    function handleRecordKey(e: KeyboardEvent) {
      const formatted = chordOf(e);
      if (!formatted) return;
      e.preventDefault();
      e.stopPropagation();

      const session = recordingRef.current;
      if (!session || session.cancelled || session.stop || session.count >= session.limit) return;
      const text = typedText(e);
      // The backend merges typed characters into one text step, so it counts the
      // steps; a key queued behind the one that filled the macro is not sent.
      session.pending = session.pending
        .then(() => (session.count >= session.limit ? session.count : recordKeystroke(formatted, text)))
        .then((count) => {
          if (session.cancelled || session.stop) return;
          session.count = count;
          setRecordedCount(count);
          if (count >= session.limit) {
            setLimitReached(true);
            void handleStopRecording();
          }
        })
        .catch((error) => {
          if (!session.cancelled) {
            setRecordingError(normalizeCommandError(error).message);
            void handleStopRecording();
          }
        });
    }

    window.addEventListener("keydown", handleRecordKey, true);
    return () => window.removeEventListener("keydown", handleRecordKey, true);
  }, [isRecording]);

  // A Send step's Record button: the next chord goes into that step (its key); Esc cancels.
  const [chordFor, setChordFor] = useState<string | null>(null);
  useEffect(() => {
    if (!chordFor) return;
    const target = chordFor;
    // As in CaptureRow: while it is held, the mouse runs nothing here and Alt+F4 can be recorded.
    const lease = acquireKeyRecording();
    void lease.ready.catch(() => {});
    function handleChordKey(e: KeyboardEvent) {
      const cancel = e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      const chord = cancel ? null : chordOf(e);
      if (!cancel && !chord) return;
      e.preventDefault();
      e.stopPropagation();
      const index = stepKeysRef.current.indexOf(target);
      const step = stepsRef.current[index];
      if (chord && step?.type === "send") {
        onChange(stepsRef.current.map((s, i) => (i === index ? { ...step, value: chord } : s)));
      }
      setChordFor(null);
    }
    window.addEventListener("keydown", handleChordKey, true);
    return () => {
      window.removeEventListener("keydown", handleChordKey, true);
      void lease.release().catch(() => {});
    };
  }, [chordFor]);

  async function handleStartRecording() {
    if (recordingRef.current) return;
    const room = MAX_SEQUENCE_STEPS - steps.length;
    if (room <= 0) {
      setLimitReached(true);
      return;
    }
    const session: RecordingSession = {
      cancelled: false, started: false, count: 0, limit: room, after: selectedKey,
      start: Promise.resolve(), pending: Promise.resolve(),
    };
    recordingRef.current = session;
    setChordFor(null);
    setRecordingBusy(true);
    setRecordedCount(0);
    setLimitReached(false);
    setRecordingError(null);
    session.start = (async () => {
      await recordingCleanup;
      if (session.cancelled) return;
      session.keyRecording = acquireKeyRecording();
      await session.keyRecording.ready;
      if (session.cancelled) return;
      await startMacroRecording();
      session.started = true;
    })();
    try {
      await session.start;
      if (!session.cancelled) setIsRecording(true);
    } catch (unknownError) {
      try { await finishRecording(session); } catch { /* The start error is shown below. */ }
      if (!session.cancelled) {
        recordingRef.current = null;
        setRecordingError(normalizeCommandError(unknownError).message);
      }
    } finally {
      if (!session.cancelled) setRecordingBusy(false);
    }
  }

  async function handleStopRecording() {
    const session = recordingRef.current;
    if (!session || session.stop) return;
    setIsRecording(false);
    setRecordingBusy(true);
    try {
      const recording = await finishRecording(session);
      if (session.cancelled) return;
      if (recording && recording.steps.length > 0) {
        // Inserted after the step picked at the start (or at the end): a
        // recording never wipes the steps already there.
        if (recording.steps.length >= session.limit) setLimitReached(true);
        insertSteps(recording.steps.slice(0, session.limit), session.after);
      }
    } catch (unknownError) {
      if (!session.cancelled) setRecordingError(normalizeCommandError(unknownError).message);
    } finally {
      if (!session.cancelled) {
        recordingRef.current = null;
        setRecordingBusy(false);
      }
    }
  }

  /** Put `added` in after the step with key `after` (or at the end), the first
   *  of them open and scrolled to. */
  function insertSteps(added: SequenceStep[], after: string | null) {
    const current = stepsRef.current;
    const room = MAX_SEQUENCE_STEPS - current.length;
    const fresh = added.slice(0, Math.max(0, room));
    if (fresh.length === 0) return;
    const keys = stepKeysRef.current.slice(0, current.length);
    const found = after ? keys.indexOf(after) : -1;
    const at = found >= 0 ? found + 1 : current.length;
    const freshKeys = fresh.map(() => newStepKey());
    keys.splice(at, 0, ...freshKeys);
    stepKeysRef.current = keys;
    setSelectedKey(freshKeys[0]!);
    revealKey.current = freshKeys[0]!;
    onChange([...current.slice(0, at), ...fresh, ...current.slice(at)]);
  }

  function addStep(type: SequenceStep["type"]) {
    insertSteps([createDefaultSequenceStep(type)], selectedKey);
  }

  function removeStep(index: number) {
    // Drop the key at the same index so the surviving steps keep their keys.
    const [gone] = stepKeysRef.current.splice(index, 1);
    if (gone === selectedKey) setSelectedKey(null);
    onChange(steps.filter((_, i) => i !== index));
  }

  function moveStep(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    // Swap the step and its parallel key in lockstep so the caret/focus follow
    // the moved row instead of staying on whatever lands at the old index.
    stepKeysRef.current = swapItems(stepKeysRef.current, index, target);
    onChange(swapItems(steps, index, target));
  }

  /** Drag a step onto another: it takes that place, the others shift. */
  function dropStep(from: number, to: number) {
    const move = <T,>(list: T[]) => { const next = [...list]; next.splice(to, 0, ...next.splice(from, 1)); return next; };
    stepKeysRef.current = move(stepKeysRef.current);
    onChange(move(steps));
  }

  function updateStep(index: number, next: SequenceStep) {
    onChange(steps.map((s, i) => (i === index ? next : s)));
  }

  /** What a collapsed row says the step does. */
  function summaryOf(step: SequenceStep): string {
    switch (step.type) {
      case "send":
        return step.value || t("picker.stepNoValue");
      case "text":
        return step.value ? `«${step.value}»` : t("picker.stepNoValue");
      case "sleep":
        return t("picker.stepSleepFor", { ms: step.delayMs ?? 0 });
      case "launch":
        return step.value.split(/[\\/]/).pop() || t("picker.stepNoValue");
      case "waitWindow":
        return t("picker.stepWaitFor", { exe: step.exe || "…", seconds: Math.round(step.timeoutMs / 100) / 10 });
    }
  }

  const STEP_ICONS: Record<SequenceStep["type"], [string, string]> = {
    send: ["shortcut", "⌨"],
    text: ["textSnippet", "T"],
    sleep: ["sleep", "⏱"],
    launch: ["launch", "↗"],
    waitWindow: ["waitWindow", "⧗"],
  };

  function renderFields(step: SequenceStep, index: number) {
    const capturing = step.type === "send" && chordFor === stepKeys[index];
    return (
      <>
        <SelectField
          label={t("picker.stepType")}
          value={step.type}
          onChange={(v) => updateStep(index, coerceSequenceStepType(step, v))}
          options={[
            { value: "send", label: t("picker.stepSend") },
            { value: "text", label: t("picker.stepText") },
            { value: "sleep", label: t("picker.stepSleep") },
            { value: "launch", label: t("picker.stepLaunch") },
            { value: "waitWindow", label: t("picker.stepWaitWindow") },
          ]}
        />

        {step.type === "waitWindow" ? (
          <>
            <label className="field">
              <span className="field__label">{t("picker.waitWindowExe")}</span>
              <input
                className="input"
                type="text"
                value={step.exe}
                placeholder="notepad.exe"
                onChange={(e) => updateStep(index, { ...step, exe: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t("picker.waitWindowTitle")}</span>
              <input
                className="input"
                type="text"
                value={step.title ?? ""}
                onChange={(e) => updateStep(index, { ...step, title: e.target.value || undefined })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t("picker.waitWindowTimeout")}</span>
              <input
                className="input"
                type="number"
                min={100}
                max={30000}
                value={step.timeoutMs}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const timeoutMs = Number.isFinite(raw) ? Math.max(100, Math.min(30000, Math.round(raw))) : 10000;
                  updateStep(index, { ...step, timeoutMs });
                }}
              />
            </label>
          </>
        ) : null}

        {step.type === "text" ? (
          <label className="field">
            <span className="field__label">{t("picker.stepValue")}</span>
            <input
              className="input"
              type="text"
              value={step.value}
              onChange={(e) => updateStep(index, { ...step, value: e.target.value })}
            />
          </label>
        ) : null}

        {step.type === "send" ? (
            <div className="field">
              <span className="field__label">{t("picker.stepValue")}</span>
              <div className="capture-row">
                <input
                  className={`input${capturing ? " capture-active" : ""}`}
                  type="text"
                  aria-label={t("picker.stepValue")}
                  readOnly={capturing}
                  value={capturing ? "" : step.value}
                  placeholder={t(capturing ? "picker.sendStepCapturing" : "picker.sendStepPlaceholder")}
                  onChange={(e) => updateStep(index, { ...step, value: e.target.value })}
                />
                <button
                  type="button"
                  className="action-button"
                  aria-pressed={capturing}
                  aria-label={capturing ? t("picker.stopCapture") : t("picker.sendStepRecord", { index: index + 1 })}
                  disabled={isRecording || recordingBusy}
                  onClick={() => setChordFor(capturing ? null : stepKeys[index]!)}
                >
                  {capturing ? t("picker.stopCapture") : t("picker.record")}
                </button>
              </div>
              <span className="sr-only" role="status">{capturing ? t("picker.sendStepCapturing") : ""}</span>
            </div>
        ) : null}

        {step.type === "launch" ? (
          <>
            <ExecutablePathField
              label={t("picker.programLabel")}
              value={step.value}
              onChange={(value) => updateStep(index, { ...step, value } as SequenceStep)}
              browseTitle={t("picker.launchBrowseProgram")}
              filterName={t("picker.launchBrowseFilter")}
              browseLabel={t("picker.launchBrowseBtn")}
            />
            <div className="field">
              <span className="field__label">{t("picker.launchArgsLabel")}</span>
              <ChipEditor
                literalValues
                values={step.args ?? []}
                onChange={(vals) =>
                  updateStep(index, {
                    ...step,
                    args: vals.length > 0 ? vals : undefined,
                  } as SequenceStep)
                }
                placeholder={t("picker.launchArgsPlaceholder")}
                ariaLabel={t("picker.launchArgsLabel")}
              />
            </div>
            <DirectoryPathField
              label={t("picker.launchWorkingDirLabel")}
              value={step.workingDir ?? ""}
              onChange={(value) =>
                updateStep(index, {
                  ...step,
                  workingDir: value.trim() ? value : undefined,
                } as SequenceStep)
              }
              browseTitle={t("picker.launchBrowseDir")}
              browseLabel={t("picker.launchBrowseDirBtn")}
              placeholder={t("picker.launchWorkingDirPlaceholder")}
            />
          </>
        ) : null}

        <div className="seq-row__pair">
          {step.type === "waitWindow" ? null : (
            <label className="field">
              <span className="field__label">{t(step.type === "sleep" ? "picker.stepSleepLength" : "picker.stepDelay")}</span>
              <input
                className="input"
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
          )}

          {(step.type === "send" || step.type === "text") && (
            <label className="field">
              <span className="field__label">{t("picker.stepRepeat")}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={step.repeat ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  const raw = v ? Number(v) : undefined;
                  const repeat =
                    raw !== undefined && Number.isFinite(raw)
                      ? Math.max(1, Math.min(100, Math.round(raw)))
                      : undefined;
                  updateStep(index, { ...step, repeat } as SequenceStep);
                }}
              />
            </label>
          )}
        </div>
      </>
    );
  }

  const selectedIndex = selectedKey ? stepKeys.indexOf(selectedKey) : -1;
  const waits = sequenceWaits(steps);
  const seconds = (ms: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(ms / 1000);

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
                className="action-button action-button--small action-button--accent"
                onClick={() => { void handleStartRecording(); }}
                disabled={recordingBusy || steps.length >= MAX_SEQUENCE_STEPS}
              >
                {t("picker.recordMacro")}
              </button>
              {(
                [
                  ["send", t("picker.addSend")],
                  ["text", t("picker.addText")],
                  ["sleep", t("picker.addSleep")],
                  ["launch", t("picker.addLaunch")],
                  ["waitWindow", t("picker.addWaitWindow")],
                ] as Array<[SequenceStep["type"], string]>
              ).map(([stepType, label]) => (
                <button
                  type="button"
                  key={stepType}
                  className="action-button action-button--secondary action-button--small"
                  onClick={() => addStep(stepType)}
                  disabled={recordingBusy || steps.length >= MAX_SEQUENCE_STEPS}
                >
                  + {label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
      {steps.length > 0 && !isRecording ? (
        <p className="panel__muted seq-where">
          {selectedIndex >= 0 ? t("picker.stepsGoAfter", { index: selectedIndex + 1 }) : t("picker.stepsGoEnd")}
        </p>
      ) : null}

      {isRecording ? (
        <Notice variant="warning" className="mb-8">
          <strong>
            {t("picker.recordingNotice")}{" "}
            <span className="text-dim">
              {t("picker.recordingCount", { count: recordedCount, max: recordingRef.current?.limit ?? MAX_SEQUENCE_STEPS })}
            </span>
          </strong>
          <p>{t("picker.recordingHint")}</p>
        </Notice>
      ) : null}
      {limitReached ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.recordLimitReached", { max: MAX_SEQUENCE_STEPS })}</strong>
        </Notice>
      ) : null}
      {steps.length >= MAX_SEQUENCE_STEPS ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.sequenceStepLimit", { max: MAX_SEQUENCE_STEPS })}</strong>
        </Notice>
      ) : steps.length === 0 ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.sequenceEmpty")}</strong>
        </Notice>
      ) : steps.some((step) => step.type === "waitWindow" && !step.exe.trim()) ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.waitWindowExeMissing")}</strong>
        </Notice>
      ) : steps.some((step) => step.type === "send" && !step.value.trim()) ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.sendStepEmpty", { index: steps.findIndex((step) => step.type === "send" && !step.value.trim()) + 1 })}</strong>
        </Notice>
      ) : null}
      {recordingError ? (
        <Notice variant="error" className="mb-8">
          <strong>{recordingError}</strong>
        </Notice>
      ) : null}
      {hasLaunchBeforeLaterStep ? (
        <Notice variant="warning" className="mb-8">
          <strong>{t("picker.sequenceLaunchRollbackWarning")}</strong>
        </Notice>
      ) : null}

      {steps.length > 0 ? (
        <div className="seq-list">
          {steps.map((step, index) => {
            const key = stepKeys[index]!;
            const open = key === selectedKey;
            const [iconId, glyph] = STEP_ICONS[step.type];
            const delay = step.type === "sleep" || step.type === "waitWindow" ? undefined : step.delayMs;
            const repeat = step.type === "send" || step.type === "text" ? step.repeat : undefined;
            return (
              <div
                key={key}
                ref={(node) => { if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }}
                className={`seq-row${open ? " seq-row--open" : ""}${dropAt === index ? " seq-row--drop" : ""}`}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(STEP_DRAG_TYPE)) return;
                  e.preventDefault();
                  setDropAt(index);
                }}
                onDragLeave={() => setDropAt(null)}
                onDrop={(e) => {
                  setDropAt(null);
                  const from = Number(e.dataTransfer.getData(STEP_DRAG_TYPE));
                  if (Number.isInteger(from) && from !== index) {
                    e.preventDefault();
                    dropStep(from, index);
                  }
                }}
              >
                <div className="seq-row__line">
                  <span
                    className="seq-row__grip"
                    draggable
                    title={t("picker.stepDrag")}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(STEP_DRAG_TYPE, String(index));
                    }}
                  >
                    ⠿
                  </span>
                  <button
                    type="button"
                    className="seq-row__main"
                    aria-expanded={open}
                    onClick={() => setSelectedKey(open ? null : key)}
                  >
                    <span className="seq-row__num">{index + 1}</span>
                    <span className="seq-row__icon" title={labelForSequenceStep(step.type)}>
                      <CategoryIcon id={iconId} fallback={glyph} size={14} />
                    </span>
                    <span className="seq-row__summary">{summaryOf(step)}</span>
                    {repeat && repeat > 1 ? <span className="seq-row__chip">×{repeat}</span> : null}
                    {delay ? <span className="seq-row__chip">{t("picker.stepDelayChip", { ms: delay })}</span> : null}
                  </button>
                  <button
                    type="button"
                    className="seq-row__tool"
                    disabled={index === 0}
                    aria-label={t("common.moveUp")}
                    title={t("common.moveUp")}
                    onClick={() => moveStep(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="seq-row__tool"
                    disabled={index === steps.length - 1}
                    aria-label={t("common.moveDown")}
                    title={t("common.moveDown")}
                    onClick={() => moveStep(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="seq-row__tool"
                    disabled={recordingBusy || steps.length >= MAX_SEQUENCE_STEPS}
                    aria-label={t("picker.stepDuplicate", { index: index + 1 })}
                    title={t("common.duplicate")}
                    onClick={() => insertSteps([structuredClone(step)], key)}
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    className="seq-row__tool seq-row__tool--danger"
                    aria-label={t("picker.stepDelete", { index: index + 1 })}
                    title={t("common.delete")}
                    onClick={() => removeStep(index)}
                  >
                    ✕
                  </button>
                </div>
                {open ? <div className="seq-row__body editor-grid">{renderFields(step, index)}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <p className="panel__muted seq-total">
          {waits.windows > 0
            ? t("picker.sequenceTotalWithWait", { count: steps.length, seconds: seconds(waits.fixed), max: seconds(waits.fixed + waits.windows) })
            : t("picker.sequenceTotal", { count: steps.length, seconds: seconds(waits.fixed) })}
        </p>
      ) : null}
      <p className="panel__muted">{t("picker.sequenceStopHint")}</p>
    </div>
  );
}

const STEP_DRAG_TYPE = "application/x-sidearm-step";
