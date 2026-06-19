import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SequenceStep } from "../../lib/config";
import {
  coerceSequenceStepType,
  createDefaultSequenceStep,
  setSequenceStepDelay,
} from "../../lib/action-helpers";
import { labelForSequenceStep } from "../../lib/labels";
import { normalizeKeyName, resolveKeyName } from "../../lib/action-picker-helpers";
import {
  recordKeystroke,
  startMacroRecording,
  stopMacroRecording,
} from "../../lib/backend";
import { ChipEditor } from "../ChipEditor";
import { ExecutablePathField } from "../ExecutablePathField";
import { DirectoryPathField } from "../DirectoryPathField";

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

  /** Hard cap on recorded steps to protect against runaway sequences. */
  const RECORD_LIMIT = 1000;

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
      setRecordedCount((c) => c + 1);
    }

    window.addEventListener("keydown", handleRecordKey, true);
    return () => window.removeEventListener("keydown", handleRecordKey, true);
  }, [isRecording]);

  // Auto-stop when the hard cap is reached.
  useEffect(() => {
    if (isRecording && recordedCount >= RECORD_LIMIT) {
      setLimitReached(true);
      void handleStopRecording();
    }
  }, [recordedCount, isRecording]);

  async function handleStartRecording() {
    try {
      setRecordedCount(0);
      setLimitReached(false);
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
        // Wholesale replacement: clear keys so the render-time reconcile mints
        // fresh ones matching the new step list.
        stepKeysRef.current = [];
        onChange(recording.steps);
      }
    } catch {
      setIsRecording(false);
    }
  }

  function addStep(type: SequenceStep["type"]) {
    stepKeysRef.current.push(newStepKey());
    onChange([...steps, createDefaultSequenceStep(type)]);
  }

  function removeStep(index: number) {
    if (steps.length <= 1) return;
    // Drop the key at the same index so the surviving steps keep their keys.
    stepKeysRef.current.splice(index, 1);
    onChange(steps.filter((_, i) => i !== index));
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
        <div className="notice notice--warning mb-8">
          <strong>
            {t("picker.recordingNotice")}{" "}
            <span className="text-dim">
              {t("picker.recordingCount", { count: recordedCount, max: RECORD_LIMIT })}
            </span>
          </strong>
          <p>{t("picker.recordingHint")}</p>
        </div>
      ) : null}
      {limitReached ? (
        <div className="notice notice--warning mb-8">
          <strong>{t("picker.recordLimitReached", { max: RECORD_LIMIT })}</strong>
        </div>
      ) : null}

      <div className="stack-list">
        {steps.map((step, index) => (
          <div className="compound-card" key={stepKeys[index]}>
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
