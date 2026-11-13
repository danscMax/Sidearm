import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SequenceStep } from "../../lib/config";
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
import { CompoundCard } from "./shared/CompoundCard";
import { acquireKeyRecording } from "./shared/key-recording";

export const MAX_SEQUENCE_STEPS = 200;

// The backend recorder is shared by editor instances, including pending teardown.
let recordingCleanup: Promise<unknown> = Promise.resolve();

interface RecordingSession {
  cancelled: boolean;
  started: boolean;
  count: number;
  start: Promise<void>;
  pending: Promise<void>;
  keyRecording?: ReturnType<typeof acquireKeyRecording>;
  stop?: Promise<MacroRecording | undefined>;
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
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [limitReached, setLimitReached] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const recordingRef = useRef<RecordingSession | null>(null);

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
  // Reconcile the key list to the current step count. Handles initial mount and
  // wholesale replacement (e.g. macro recording overwrites all steps).
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
      // Ignore bare modifiers
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const rawKey = resolveKeyName(e);
      if (rawKey === "VK_232") return;
      e.preventDefault();
      e.stopPropagation();

      const session = recordingRef.current;
      if (!session || session.cancelled || session.stop || session.count >= MAX_SEQUENCE_STEPS) return;
      // Canonical Ctrl→Shift→Alt→Win order (+ Win, previously missing) via the
      // shared modifierLabels helper, so recorded chords match the rest of the UI.
      const mods = modifierLabels({
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        win: e.metaKey,
      });
      const keyName = normalizeKeyName(rawKey);
      const formatted = [...mods, keyName].join("+");

      session.pending = session.pending.then(() => recordKeystroke(formatted)).catch((error) => {
        if (!session.cancelled) {
          setRecordingError(normalizeCommandError(error).message);
          void handleStopRecording();
        }
      });
      session.count += 1;
      setRecordedCount(session.count);
      if (session.count >= MAX_SEQUENCE_STEPS) {
        setLimitReached(true);
        void handleStopRecording();
      }
    }

    window.addEventListener("keydown", handleRecordKey, true);
    return () => window.removeEventListener("keydown", handleRecordKey, true);
  }, [isRecording]);

  async function handleStartRecording() {
    if (recordingRef.current) return;
    const session: RecordingSession = {
      cancelled: false, started: false, count: 0,
      start: Promise.resolve(), pending: Promise.resolve(),
    };
    recordingRef.current = session;
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
        // Wholesale replacement: clear keys so the render-time reconcile mints
        // fresh ones matching the new step list.
        stepKeysRef.current = [];
        if (recording.steps.length >= MAX_SEQUENCE_STEPS) setLimitReached(true);
        onChange(recording.steps.slice(0, MAX_SEQUENCE_STEPS));
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

  function addStep(type: SequenceStep["type"]) {
    if (steps.length >= MAX_SEQUENCE_STEPS) return;
    stepKeysRef.current.push(newStepKey());
    onChange([...steps, createDefaultSequenceStep(type)]);
  }

  function removeStep(index: number) {
    if (steps.length <= 1) return;
    // Drop the key at the same index so the surviving steps keep their keys.
    stepKeysRef.current.splice(index, 1);
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
                disabled={recordingBusy}
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
                  disabled={recordingBusy || steps.length >= MAX_SEQUENCE_STEPS}
                >
                  + {label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {isRecording ? (
        <Notice variant="warning" className="mb-8">
          <strong>
            {t("picker.recordingNotice")}{" "}
            <span className="text-dim">
              {t("picker.recordingCount", { count: recordedCount, max: MAX_SEQUENCE_STEPS })}
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

      <div className="stack-list">
        {steps.map((step, index) => (
          <CompoundCard
            key={stepKeys[index]}
            title={t("picker.stepTitle", { index: index + 1 })}
            meta={labelForSequenceStep(step.type)}
            removeLabel={t("common.delete")}
            canRemove={steps.length !== 1}
            onRemove={() => removeStep(index)}
            onMoveUp={() => moveStep(index, -1)}
            onMoveDown={() => moveStep(index, 1)}
            canMoveUp={index > 0}
            canMoveDown={index < steps.length - 1}
            moveUpLabel={t("common.moveUp")}
            moveDownLabel={t("common.moveDown")}
            reorder={{ index, onMove: dropStep }}
          >
              <SelectField
                label={t("picker.stepType")}
                value={step.type}
                onChange={(v) => updateStep(index, coerceSequenceStepType(step, v))}
                options={[
                  { value: "send", label: t("picker.stepSend") },
                  { value: "text", label: t("picker.stepText") },
                  { value: "sleep", label: t("picker.stepSleep") },
                  { value: "launch", label: t("picker.stepLaunch") },
                ]}
              />

              {step.type === "send" || step.type === "text" ? (
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

              {(step.type === "send" || step.type === "text") && (
                <label className="field">
                  <span className="field__label">{t("picker.stepRepeat")}</span>
                  <input
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
          </CompoundCard>
        ))}
      </div>
    </div>
  );
}
