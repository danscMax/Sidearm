import type {
  AppConfig,
  CapabilityStatus,
  ControlFamily,
  ControlId,
  Layer,
} from "./config";
import type { EncodedKeyEvent, ResolvedInputPreview, WindowCaptureResult } from "./runtime";
import { expectedEncodedKeyForControl } from "./config-editing";

export type VerificationSessionScope = "currentFamily" | "all";
export type VerificationStepResult =
  | "pending"
  | "matched"
  | "mismatched"
  | "noSignal"
  | "skipped";

export interface VerificationSessionStep {
  controlId: ControlId;
  controlLabel: string;
  family: ControlFamily;
  layer: Layer;
  capabilityStatus: CapabilityStatus;
  expectedEncodedKey: string | null;
  configuredEncodedKey: string | null;
  startedAt: number | null;
  observedEncodedKey: string | null;
  observedAt: number | null;
  observedBackend: string | null;
  activeExe: string | null;
  activeWindowTitle: string | null;
  resolutionStatus: ResolvedInputPreview["status"] | null;
  resolvedControlId: string | null;
  resolvedLayer: string | null;
  result: VerificationStepResult;
  notes: string;
}

export interface VerificationSession {
  sessionId: string;
  scope: VerificationSessionScope;
  layer: Layer;
  profileId: string | null;
  startedAt: number;
  completedAt: number | null;
  activeStepIndex: number;
  steps: VerificationSessionStep[];
}

export interface VerificationSessionSummary {
  total: number;
  matched: number;
  mismatched: number;
  noSignal: number;
  skipped: number;
  pending: number;
}

export interface VerificationSessionExport {
  version: 1;
  generatedAt: number;
  session: VerificationSession;
  summary: VerificationSessionSummary;
}

export function createVerificationSession(
  config: AppConfig,
  layer: Layer,
  profileId: string | null,
  selectedControlId: ControlId | null,
  scope: VerificationSessionScope,
): VerificationSession | null {
  const selectedControl =
    selectedControlId === null
      ? null
      : config.physicalControls.find((control) => control.id === selectedControlId) ?? null;

  if (scope === "currentFamily" && !selectedControl) {
    return null;
  }

  const controls = config.physicalControls.filter((control) =>
    scope === "all" ? true : control.family === selectedControl?.family,
  );

  if (controls.length === 0) {
    return null;
  }

  const encoderByControlId = new Map(
    config.encoderMappings
      .filter((mapping) => mapping.layer === layer)
      .map((mapping) => [mapping.controlId, mapping.encodedKey]),
  );

  const startedAt = Date.now();
  const steps = controls.map((control, index) => ({
    controlId: control.id,
    controlLabel: control.synapseName ?? control.defaultName,
    family: control.family,
    layer,
    capabilityStatus: control.capabilityStatus,
    expectedEncodedKey: expectedEncodedKeyForControl(control.id, layer),
    configuredEncodedKey: encoderByControlId.get(control.id) ?? null,
    startedAt: index === 0 ? startedAt : null,
    observedEncodedKey: null,
    observedAt: null,
    observedBackend: null,
    activeExe: null,
    activeWindowTitle: null,
    resolutionStatus: null,
    resolvedControlId: null,
    resolvedLayer: null,
    result: "pending" as const,
    notes: "",
  }));

  return {
    sessionId: `verification-${startedAt}`,
    scope,
    layer,
    profileId,
    startedAt,
    completedAt: null,
    activeStepIndex: 0,
    steps,
  };
}

export function activeVerificationStep(
  session: VerificationSession | null,
): VerificationSessionStep | null {
  if (!session) {
    return null;
  }

  return session.steps[session.activeStepIndex] ?? null;
}

export function restartVerificationStep(
  session: VerificationSession,
  now: number,
): VerificationSession {
  return updateStep(session, session.activeStepIndex, (step) => ({
    ...step,
    startedAt: now,
    observedEncodedKey: null,
    observedAt: null,
    observedBackend: null,
    activeExe: null,
    activeWindowTitle: null,
    resolutionStatus: null,
    resolvedControlId: null,
    resolvedLayer: null,
    result: "pending",
  }));
}

export function captureVerificationObservation(
  session: VerificationSession,
  event: EncodedKeyEvent,
): VerificationSession {
  const step = activeVerificationStep(session);
  if (!step?.startedAt || event.receivedAt < step.startedAt) {
    return session;
  }

  return updateStep(session, session.activeStepIndex, (currentStep) => ({
    ...currentStep,
    observedEncodedKey: event.encodedKey,
    observedAt: event.receivedAt,
    observedBackend: event.backend,
  }));
}

export function finalizeVerificationStep(
  session: VerificationSession,
  result: Exclude<VerificationStepResult, "pending">,
  capture: WindowCaptureResult | null,
  preview: ResolvedInputPreview | null,
  notes?: string,
): VerificationSession {
  const nextSession = updateStep(session, session.activeStepIndex, (step) => ({
    ...step,
    result,
    activeExe: capture && !capture.ignored ? capture.exe : step.activeExe,
    activeWindowTitle: capture && !capture.ignored ? capture.title : step.activeWindowTitle,
    resolutionStatus: preview?.status ?? step.resolutionStatus,
    resolvedControlId: preview?.controlId ?? step.resolvedControlId,
    resolvedLayer: preview?.layer ?? step.resolvedLayer,
    notes: notes ?? step.notes,
  }));

  const nextIndex = nextSession.activeStepIndex + 1;
  if (nextIndex >= nextSession.steps.length) {
    return {
      ...nextSession,
      activeStepIndex: nextSession.steps.length,
      completedAt: Date.now(),
    };
  }

  const resumed = {
    ...nextSession,
    activeStepIndex: nextIndex,
  };

  return updateStep(resumed, nextIndex, (step) => ({
    ...step,
    startedAt: Date.now(),
  }));
}

export function updateVerificationStepNotes(
  session: VerificationSession,
  notes: string,
): VerificationSession {
  return updateStep(session, session.activeStepIndex, (step) => ({
    ...step,
    notes,
  }));
}

export function summarizeVerificationSession(
  session: VerificationSession | null,
): VerificationSessionSummary {
  const steps = session?.steps ?? [];
  return {
    total: steps.length,
    matched: steps.filter((step) => step.result === "matched").length,
    mismatched: steps.filter((step) => step.result === "mismatched").length,
    noSignal: steps.filter((step) => step.result === "noSignal").length,
    skipped: steps.filter((step) => step.result === "skipped").length,
    pending: steps.filter((step) => step.result === "pending").length,
  };
}

export function suggestedVerificationStepResult(
  step: VerificationSessionStep | null,
  selectedControlId: ControlId | null,
  selectedLayer: Layer,
): Exclude<VerificationStepResult, "pending"> | null {
  if (!step) {
    return null;
  }

  if (!step.observedEncodedKey) {
    return "noSignal";
  }

  if (
    step.configuredEncodedKey &&
    step.observedEncodedKey === step.configuredEncodedKey &&
    step.resolvedControlId === selectedControlId &&
    step.resolvedLayer === selectedLayer
  ) {
    return "matched";
  }

  return "mismatched";
}

export function createVerificationSessionExport(
  session: VerificationSession,
): VerificationSessionExport {
  return {
    version: 1,
    generatedAt: Date.now(),
    summary: summarizeVerificationSession(session),
    session,
  };
}

function updateStep(
  session: VerificationSession,
  index: number,
  updateStepValue: (step: VerificationSessionStep) => VerificationSessionStep,
): VerificationSession {
  return {
    ...session,
    steps: session.steps.map((step, stepIndex) =>
      stepIndex === index ? updateStepValue(step) : step,
    ),
  };
}
