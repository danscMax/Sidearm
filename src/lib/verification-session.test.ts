import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AppConfig,
  CapabilityStatus,
  ControlFamily,
  ControlId,
  EncoderMapping,
  PhysicalControl,
  Settings,
} from "./config";
import type {
  EncodedKeyEvent,
  ResolvedInputPreview,
  WindowCaptureResult,
} from "./runtime";
import type {
  VerificationSession,
  VerificationSessionStep,
} from "./verification-session";
import {
  createVerificationSession,
  activeVerificationStep,
  restartVerificationStep,
  captureVerificationObservation,
  finalizeVerificationStep,
  updateVerificationStepNotes,
  summarizeVerificationSession,
  suggestedVerificationStepResult,
  navigateToVerificationStep,
  reopenVerificationStep,
  createVerificationSessionExport,
} from "./verification-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestSettings(): Settings {
  return {
    fallbackProfileId: "default",
    theme: "dark",
    startWithWindows: false,
    minimizeToTray: false,
    debugLogging: false,
  };
}

function createPhysicalControl(
  id: ControlId,
  family: ControlFamily,
  capabilityStatus: CapabilityStatus = "verified",
  synapseName?: string,
): PhysicalControl {
  return {
    id,
    family,
    defaultName: `Default ${id}`,
    synapseName,
    remappable: true,
    capabilityStatus,
  };
}

function createTestConfig(): AppConfig {
  const physicalControls: PhysicalControl[] = [
    createPhysicalControl("thumb_01", "thumbGrid", "verified", "Thumb 1"),
    createPhysicalControl("thumb_02", "thumbGrid", "verified"),
    createPhysicalControl("thumb_03", "thumbGrid", "verified"),
    createPhysicalControl("mouse_left", "topPanel", "reserved"),
    createPhysicalControl("mouse_right", "topPanel", "reserved"),
    createPhysicalControl("mouse_4", "topPanel", "needsValidation"),
    createPhysicalControl("mouse_5", "topPanel", "verified"),
    createPhysicalControl("wheel_click", "wheel", "verified"),
    createPhysicalControl("wheel_up", "wheel", "verified"),
  ];

  const encoderMappings: EncoderMapping[] = [
    {
      controlId: "thumb_01",
      layer: "standard",
      encodedKey: "F13",
      source: "synapse",
      verified: true,
    },
    {
      controlId: "thumb_02",
      layer: "standard",
      encodedKey: "F14",
      source: "synapse",
      verified: false,
    },
    {
      controlId: "mouse_4",
      layer: "standard",
      encodedKey: "Ctrl+Shift+F13",
      source: "synapse",
      verified: false,
    },
    {
      controlId: "thumb_01",
      layer: "hypershift",
      encodedKey: "Ctrl+Alt+Shift+F13",
      source: "synapse",
      verified: false,
    },
  ];

  return {
    version: 1,
    settings: createTestSettings(),
    profiles: [{ id: "default", name: "Default", enabled: true, priority: 10 }],
    physicalControls,
    encoderMappings,
    appMappings: [],
    bindings: [],
    actions: [],
    snippetLibrary: [],
  };
}

function createTestStep(
  overrides: Partial<VerificationSessionStep> = {},
): VerificationSessionStep {
  return {
    controlId: "thumb_01",
    controlLabel: "Thumb 1",
    family: "thumbGrid",
    layer: "standard",
    capabilityStatus: "verified",
    expectedEncodedKey: "F13",
    configuredEncodedKey: "F13",
    startedAt: 1000,
    observedEncodedKey: null,
    observedAt: null,
    observedBackend: null,
    activeExe: null,
    activeWindowTitle: null,
    resolutionStatus: null,
    resolvedControlId: null,
    resolvedLayer: null,
    result: "pending",
    notes: "",
    ...overrides,
  };
}

function createTestSession(
  overrides: Partial<VerificationSession> = {},
  stepOverrides: Partial<VerificationSessionStep>[] = [],
): VerificationSession {
  const defaultSteps: VerificationSessionStep[] = [
    createTestStep({
      controlId: "thumb_01",
      controlLabel: "Thumb 1",
      expectedEncodedKey: "F13",
      configuredEncodedKey: "F13",
      startedAt: 1000,
    }),
    createTestStep({
      controlId: "thumb_02",
      controlLabel: "Default thumb_02",
      expectedEncodedKey: "F14",
      configuredEncodedKey: "F14",
      startedAt: null,
    }),
    createTestStep({
      controlId: "thumb_03",
      controlLabel: "Default thumb_03",
      expectedEncodedKey: "F15",
      configuredEncodedKey: null,
      startedAt: null,
    }),
  ];

  const steps =
    stepOverrides.length > 0
      ? stepOverrides.map((so, i) =>
          createTestStep({ ...defaultSteps[i], ...so }),
        )
      : defaultSteps;

  return {
    sessionId: "verification-1000",
    scope: "all",
    layer: "standard",
    profileId: "default",
    startedAt: 1000,
    completedAt: null,
    activeStepIndex: 0,
    steps,
    ...overrides,
  };
}

function createEncodedKeyEvent(
  overrides: Partial<EncodedKeyEvent> = {},
): EncodedKeyEvent {
  return {
    encodedKey: "F13",
    backend: "windows-register-hotkey",
    receivedAt: 2000,
    isRepeat: false,
    ...overrides,
  };
}

function createWindowCapture(
  overrides: Partial<WindowCaptureResult> = {},
): WindowCaptureResult {
  return {
    hwnd: "12345",
    exe: "notepad.exe",
    processPath: "C:\\Windows\\notepad.exe",
    title: "Untitled - Notepad",
    capturedAt: 2000,
    ignored: false,
    usedFallbackProfile: false,
    candidateAppMappingIds: [],
    resolutionReason: "fallback",
    isElevated: false,
    ...overrides,
  };
}

function createResolvedPreview(
  overrides: Partial<ResolvedInputPreview> = {},
): ResolvedInputPreview {
  return {
    status: "resolved",
    encodedKey: "F13",
    reason: "matched",
    usedFallbackProfile: false,
    candidateAppMappingIds: [],
    candidateControlIds: ["thumb_01"],
    controlId: "thumb_01",
    layer: "standard",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVerificationSession", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(5000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("creates session with currentFamily scope for selected control's family", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      "default",
      "thumb_01",
      "currentFamily",
    );

    expect(session).not.toBeNull();
    expect(session!.scope).toBe("currentFamily");
    expect(session!.layer).toBe("standard");
    expect(session!.profileId).toBe("default");
    expect(session!.steps.every((s) => s.family === "thumbGrid")).toBe(true);
    expect(session!.steps.length).toBeGreaterThan(0);
  });

  it("returns null for currentFamily scope without selected control", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      "default",
      null,
      "currentFamily",
    );

    expect(session).toBeNull();
  });

  it("includes all non-reserved controls for 'all' scope", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      "default",
      null,
      "all",
    );

    expect(session).not.toBeNull();
    const controlIds = session!.steps.map((s) => s.controlId);
    // Reserved controls should not be present
    expect(controlIds).not.toContain("mouse_left");
    expect(controlIds).not.toContain("mouse_right");
  });

  it("filters out reserved controls", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    const statuses = session!.steps.map((s) => s.capabilityStatus);
    expect(statuses).not.toContain("reserved");
  });

  it("returns null when no controls match (no expected or configured keys)", () => {
    const config: AppConfig = {
      ...createTestConfig(),
      physicalControls: [
        createPhysicalControl("top_special_01", "system", "verified"),
      ],
      encoderMappings: [],
    };
    // top_special_01 has no expected key and no encoder mapping
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).toBeNull();
  });

  it("first step gets startedAt, rest get null", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    expect(session!.steps.length).toBeGreaterThan(1);
    expect(session!.steps[0].startedAt).toBe(5000);
    for (let i = 1; i < session!.steps.length; i++) {
      expect(session!.steps[i].startedAt).toBeNull();
    }
  });

  it("correctly picks up encoder mappings for the layer", () => {
    const config = createTestConfig();
    const standardSession = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(standardSession).not.toBeNull();
    const thumb01Step = standardSession!.steps.find(
      (s) => s.controlId === "thumb_01",
    );
    expect(thumb01Step?.configuredEncodedKey).toBe("F13");

    const hypershiftSession = createVerificationSession(
      config,
      "hypershift",
      null,
      null,
      "all",
    );

    expect(hypershiftSession).not.toBeNull();
    const hsThumb01Step = hypershiftSession!.steps.find(
      (s) => s.controlId === "thumb_01",
    );
    expect(hsThumb01Step?.configuredEncodedKey).toBe("Ctrl+Alt+Shift+F13");
  });

  it("uses synapseName when available, defaultName otherwise", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    const thumb01 = session!.steps.find((s) => s.controlId === "thumb_01");
    const thumb02 = session!.steps.find((s) => s.controlId === "thumb_02");
    expect(thumb01?.controlLabel).toBe("Thumb 1"); // synapseName
    expect(thumb02?.controlLabel).toBe("Default thumb_02"); // defaultName
  });

  it("sets sessionId based on timestamp", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("verification-5000");
  });

  it("sets completedAt to null and activeStepIndex to 0", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    expect(session!.completedAt).toBeNull();
    expect(session!.activeStepIndex).toBe(0);
  });

  it("all steps initialized with pending result and empty notes", () => {
    const config = createTestConfig();
    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );

    expect(session).not.toBeNull();
    for (const step of session!.steps) {
      expect(step.result).toBe("pending");
      expect(step.notes).toBe("");
      expect(step.observedEncodedKey).toBeNull();
      expect(step.observedAt).toBeNull();
      expect(step.observedBackend).toBeNull();
      expect(step.activeExe).toBeNull();
      expect(step.activeWindowTitle).toBeNull();
      expect(step.resolutionStatus).toBeNull();
      expect(step.resolvedControlId).toBeNull();
      expect(step.resolvedLayer).toBeNull();
    }
  });
});

describe("activeVerificationStep", () => {
  it("returns step at activeStepIndex", () => {
    const session = createTestSession({ activeStepIndex: 1 });
    const step = activeVerificationStep(session);

    expect(step).not.toBeNull();
    expect(step!.controlId).toBe("thumb_02");
  });

  it("returns null for null session", () => {
    expect(activeVerificationStep(null)).toBeNull();
  });

  it("returns null when index is out of bounds", () => {
    const session = createTestSession({ activeStepIndex: 99 });
    expect(activeVerificationStep(session)).toBeNull();
  });

  it("returns first step when activeStepIndex is 0", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const step = activeVerificationStep(session);
    expect(step!.controlId).toBe("thumb_01");
  });
});

describe("restartVerificationStep", () => {
  it("resets observation fields", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [
        {
          observedEncodedKey: "F13",
          observedAt: 2000,
          observedBackend: "hook",
          activeExe: "notepad.exe",
          activeWindowTitle: "Notepad",
          resolutionStatus: "resolved",
          resolvedControlId: "thumb_01",
          resolvedLayer: "standard",
          result: "matched",
        },
        {},
        {},
      ],
    );

    const restarted = restartVerificationStep(session, 9000);
    const step = restarted.steps[0];

    expect(step.observedEncodedKey).toBeNull();
    expect(step.observedAt).toBeNull();
    expect(step.observedBackend).toBeNull();
    expect(step.activeExe).toBeNull();
    expect(step.activeWindowTitle).toBeNull();
    expect(step.resolutionStatus).toBeNull();
    expect(step.resolvedControlId).toBeNull();
    expect(step.resolvedLayer).toBeNull();
  });

  it("sets new startedAt", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const restarted = restartVerificationStep(session, 9999);
    expect(restarted.steps[0].startedAt).toBe(9999);
  });

  it("resets result to pending", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ result: "matched" }, {}, {}],
    );

    const restarted = restartVerificationStep(session, 9000);
    expect(restarted.steps[0].result).toBe("pending");
  });

  it("does not modify other steps", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const restarted = restartVerificationStep(session, 9000);

    expect(restarted.steps[1]).toEqual(session.steps[1]);
    expect(restarted.steps[2]).toEqual(session.steps[2]);
  });
});

describe("captureVerificationObservation", () => {
  it("captures encoded key from event", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const event = createEncodedKeyEvent({
      encodedKey: "F13",
      backend: "hook-v2",
      receivedAt: 2000,
    });

    const updated = captureVerificationObservation(session, event);
    const step = updated.steps[0];

    expect(step.observedEncodedKey).toBe("F13");
    expect(step.observedAt).toBe(2000);
    expect(step.observedBackend).toBe("hook-v2");
  });

  it("ignores events before step startedAt", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    // step startedAt is 1000
    const event = createEncodedKeyEvent({ receivedAt: 999 });

    const updated = captureVerificationObservation(session, event);
    expect(updated).toBe(session); // reference equality -- unchanged
  });

  it("ignores if step has no startedAt", () => {
    const session = createTestSession({ activeStepIndex: 1 });
    // step[1] has startedAt: null
    const event = createEncodedKeyEvent({ receivedAt: 5000 });

    const updated = captureVerificationObservation(session, event);
    expect(updated).toBe(session);
  });

  it("updates the active step only", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const event = createEncodedKeyEvent({ encodedKey: "F99", receivedAt: 2000 });

    const updated = captureVerificationObservation(session, event);
    expect(updated.steps[0].observedEncodedKey).toBe("F99");
    expect(updated.steps[1].observedEncodedKey).toBeNull();
    expect(updated.steps[2].observedEncodedKey).toBeNull();
  });

  it("captures event exactly at startedAt (not before)", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    // step startedAt is 1000, event receivedAt is also 1000
    const event = createEncodedKeyEvent({
      encodedKey: "F13",
      receivedAt: 1000,
    });

    const updated = captureVerificationObservation(session, event);
    expect(updated.steps[0].observedEncodedKey).toBe("F13");
    expect(updated.steps[0].observedAt).toBe(1000);
  });

  it("overwrites previous observation with new event", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [
        {
          observedEncodedKey: "F10",
          observedAt: 1500,
          observedBackend: "old-backend",
        },
        {},
        {},
      ],
    );

    const event = createEncodedKeyEvent({
      encodedKey: "F13",
      backend: "new-backend",
      receivedAt: 2000,
    });

    const updated = captureVerificationObservation(session, event);
    expect(updated.steps[0].observedEncodedKey).toBe("F13");
    expect(updated.steps[0].observedBackend).toBe("new-backend");
    expect(updated.steps[0].observedAt).toBe(2000);
  });
});

describe("finalizeVerificationStep", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("sets result on active step", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
    );

    expect(finalized.steps[0].result).toBe("matched");
  });

  it("captures window info from capture", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const capture = createWindowCapture({
      exe: "code.exe",
      title: "VS Code",
    });

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      capture,
      null,
    );

    expect(finalized.steps[0].activeExe).toBe("code.exe");
    expect(finalized.steps[0].activeWindowTitle).toBe("VS Code");
  });

  it("captures resolution info from preview", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const preview = createResolvedPreview({
      status: "resolved",
      controlId: "thumb_01",
      layer: "standard",
    });

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      preview,
    );

    expect(finalized.steps[0].resolutionStatus).toBe("resolved");
    expect(finalized.steps[0].resolvedControlId).toBe("thumb_01");
    expect(finalized.steps[0].resolvedLayer).toBe("standard");
  });

  it("advances to next step and sets its startedAt", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
    );

    expect(finalized.activeStepIndex).toBe(1);
    expect(finalized.steps[1].startedAt).toBe(8000);
    expect(finalized.completedAt).toBeNull();
  });

  it("on last step: sets completedAt and index to steps.length", () => {
    const session = createTestSession({ activeStepIndex: 2 });
    const finalized = finalizeVerificationStep(
      session,
      "skipped",
      null,
      null,
    );

    expect(finalized.activeStepIndex).toBe(3);
    expect(finalized.completedAt).toBe(8000);
  });

  it("does not capture window info when capture is null", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ activeExe: "existing.exe", activeWindowTitle: "Existing" }, {}, {}],
    );

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
    );

    expect(finalized.steps[0].activeExe).toBe("existing.exe");
    expect(finalized.steps[0].activeWindowTitle).toBe("Existing");
  });

  it("does not capture window info when capture.ignored is true", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ activeExe: "old.exe", activeWindowTitle: "Old" }, {}, {}],
    );
    const capture = createWindowCapture({
      exe: "new.exe",
      title: "New",
      ignored: true,
    });

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      capture,
      null,
    );

    expect(finalized.steps[0].activeExe).toBe("old.exe");
    expect(finalized.steps[0].activeWindowTitle).toBe("Old");
  });

  it("preserves notes from step when notes param is not provided", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ notes: "Keep these notes" }, {}, {}],
    );

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
    );

    expect(finalized.steps[0].notes).toBe("Keep these notes");
  });

  it("updates notes when notes param is provided", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ notes: "Old notes" }, {}, {}],
    );

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
      "New notes",
    );

    expect(finalized.steps[0].notes).toBe("New notes");
  });

  it("single step session completes immediately", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ controlId: "thumb_01" }],
    );

    const finalized = finalizeVerificationStep(
      session,
      "matched",
      null,
      null,
    );

    expect(finalized.activeStepIndex).toBe(1);
    expect(finalized.completedAt).toBe(8000);
  });

  it("does not modify other steps' results", () => {
    const session = createTestSession(
      { activeStepIndex: 1 },
      [{ result: "matched", startedAt: 1000 }, { startedAt: 3000 }, {}],
    );

    const finalized = finalizeVerificationStep(
      session,
      "noSignal",
      null,
      null,
    );

    expect(finalized.steps[0].result).toBe("matched");
    expect(finalized.steps[1].result).toBe("noSignal");
  });
});

describe("updateVerificationStepNotes", () => {
  it("updates notes on active step", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const updated = updateVerificationStepNotes(
      session,
      "Test observation notes",
    );

    expect(updated.steps[0].notes).toBe("Test observation notes");
  });

  it("does not affect other steps", () => {
    const session = createTestSession(
      { activeStepIndex: 1 },
      [{ notes: "Step 0 notes" }, {}, { notes: "Step 2 notes" }],
    );

    const updated = updateVerificationStepNotes(
      session,
      "Updated step 1 notes",
    );

    expect(updated.steps[0].notes).toBe("Step 0 notes");
    expect(updated.steps[1].notes).toBe("Updated step 1 notes");
    expect(updated.steps[2].notes).toBe("Step 2 notes");
  });

  it("can set empty notes", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ notes: "Some notes" }, {}, {}],
    );

    const updated = updateVerificationStepNotes(session, "");
    expect(updated.steps[0].notes).toBe("");
  });
});

describe("summarizeVerificationSession", () => {
  it("counts all result types", () => {
    const session = createTestSession(
      {},
      [
        { result: "matched" },
        { result: "mismatched" },
        { result: "noSignal" },
      ],
    );

    const summary = summarizeVerificationSession(session);

    expect(summary.total).toBe(3);
    expect(summary.matched).toBe(1);
    expect(summary.mismatched).toBe(1);
    expect(summary.noSignal).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.pending).toBe(0);
  });

  it("null session returns all zeros", () => {
    const summary = summarizeVerificationSession(null);

    expect(summary.total).toBe(0);
    expect(summary.matched).toBe(0);
    expect(summary.mismatched).toBe(0);
    expect(summary.noSignal).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.pending).toBe(0);
  });

  it("mixed results counted correctly", () => {
    const session: VerificationSession = {
      ...createTestSession(),
      steps: [
        createTestStep({ result: "matched" }),
        createTestStep({ result: "matched" }),
        createTestStep({ result: "mismatched" }),
        createTestStep({ result: "skipped" }),
        createTestStep({ result: "skipped" }),
        createTestStep({ result: "pending" }),
        createTestStep({ result: "noSignal" }),
      ],
    };

    const summary = summarizeVerificationSession(session);

    expect(summary.total).toBe(7);
    expect(summary.matched).toBe(2);
    expect(summary.mismatched).toBe(1);
    expect(summary.noSignal).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.pending).toBe(1);
  });

  it("session with all pending steps", () => {
    const summary = summarizeVerificationSession(createTestSession());

    expect(summary.total).toBe(3);
    expect(summary.pending).toBe(3);
    expect(summary.matched).toBe(0);
  });
});

describe("suggestedVerificationStepResult", () => {
  it("null step returns null", () => {
    const result = suggestedVerificationStepResult(null, "thumb_01", "standard");
    expect(result).toBeNull();
  });

  it("no observation returns noSignal", () => {
    const step = createTestStep({ observedEncodedKey: null });
    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("noSignal");
  });

  it("matching configured key + control + layer returns matched", () => {
    const step = createTestStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("matched");
  });

  it("different observed key returns mismatched", () => {
    const step = createTestStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F14",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("mismatched");
  });

  it("missing configured key returns mismatched", () => {
    const step = createTestStep({
      configuredEncodedKey: null,
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "standard",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("mismatched");
  });

  it("matching key but different control returns mismatched", () => {
    const step = createTestStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_02",
      resolvedLayer: "standard",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("mismatched");
  });

  it("matching key but different layer returns mismatched", () => {
    const step = createTestStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: "thumb_01",
      resolvedLayer: "hypershift",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("mismatched");
  });

  it("null resolvedControlId with observed key returns mismatched", () => {
    const step = createTestStep({
      configuredEncodedKey: "F13",
      observedEncodedKey: "F13",
      resolvedControlId: null,
      resolvedLayer: "standard",
    });

    const result = suggestedVerificationStepResult(
      step,
      "thumb_01",
      "standard",
    );
    expect(result).toBe("mismatched");
  });
});

describe("navigateToVerificationStep", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(7000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("valid index navigates", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const navigated = navigateToVerificationStep(session, 2);

    expect(navigated.activeStepIndex).toBe(2);
  });

  it("out-of-bounds negative returns unchanged session", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const result = navigateToVerificationStep(session, -1);

    expect(result).toBe(session);
  });

  it("out-of-bounds too large returns unchanged session", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const result = navigateToVerificationStep(session, 99);

    expect(result).toBe(session);
  });

  it("out-of-bounds exactly at steps.length returns unchanged session", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    const result = navigateToVerificationStep(session, session.steps.length);

    expect(result).toBe(session);
  });

  it("pending step with no startedAt gets startedAt set", () => {
    const session = createTestSession({ activeStepIndex: 0 });
    // step[1] has result: "pending" and startedAt: null
    const navigated = navigateToVerificationStep(session, 1);

    expect(navigated.steps[1].startedAt).toBe(7000);
  });

  it("already-started step does not get re-started", () => {
    const session = createTestSession(
      { activeStepIndex: 1 },
      [{ startedAt: 1000 }, { startedAt: 3000 }, {}],
    );

    const navigated = navigateToVerificationStep(session, 0);
    expect(navigated.steps[0].startedAt).toBe(1000); // unchanged
  });

  it("non-pending step does not get startedAt overwritten", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [
        {},
        { result: "matched", startedAt: 2000 },
        {},
      ],
    );

    const navigated = navigateToVerificationStep(session, 1);
    expect(navigated.steps[1].startedAt).toBe(2000); // unchanged
  });

  it("clears completedAt", () => {
    const session = createTestSession({
      activeStepIndex: 2,
      completedAt: 6000,
    });

    const navigated = navigateToVerificationStep(session, 0);
    expect(navigated.completedAt).toBeNull();
  });

  it("navigating to already-active index still clears completedAt", () => {
    const session = createTestSession({
      activeStepIndex: 0,
      completedAt: 6000,
    });

    const navigated = navigateToVerificationStep(session, 0);
    expect(navigated.completedAt).toBeNull();
    expect(navigated.activeStepIndex).toBe(0);
  });
});

describe("reopenVerificationStep", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(10000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("valid index resets step", () => {
    const session = createTestSession(
      { activeStepIndex: 2 },
      [
        {
          result: "matched",
          observedEncodedKey: "F13",
          observedAt: 2000,
          observedBackend: "hook",
          activeExe: "app.exe",
          activeWindowTitle: "App",
          resolutionStatus: "resolved",
          resolvedControlId: "thumb_01",
          resolvedLayer: "standard",
          startedAt: 1000,
        },
        {},
        {},
      ],
    );

    const reopened = reopenVerificationStep(session, 0);

    expect(reopened.activeStepIndex).toBe(0);
    const step = reopened.steps[0];
    expect(step.result).toBe("pending");
    expect(step.startedAt).toBe(10000);
  });

  it("clears all observation fields", () => {
    const session = createTestSession(
      {},
      [
        {
          observedEncodedKey: "F13",
          observedAt: 2000,
          observedBackend: "hook",
          activeExe: "notepad.exe",
          activeWindowTitle: "Notepad",
          resolutionStatus: "resolved",
          resolvedControlId: "thumb_01",
          resolvedLayer: "standard",
          result: "matched",
        },
        {},
        {},
      ],
    );

    const reopened = reopenVerificationStep(session, 0);
    const step = reopened.steps[0];

    expect(step.observedEncodedKey).toBeNull();
    expect(step.observedAt).toBeNull();
    expect(step.observedBackend).toBeNull();
    expect(step.activeExe).toBeNull();
    expect(step.activeWindowTitle).toBeNull();
    expect(step.resolutionStatus).toBeNull();
    expect(step.resolvedControlId).toBeNull();
    expect(step.resolvedLayer).toBeNull();
  });

  it("sets result to pending", () => {
    const session = createTestSession(
      {},
      [{ result: "skipped" }, {}, {}],
    );

    const reopened = reopenVerificationStep(session, 0);
    expect(reopened.steps[0].result).toBe("pending");
  });

  it("sets new startedAt", () => {
    const session = createTestSession(
      {},
      [{ startedAt: 1000 }, {}, {}],
    );

    const reopened = reopenVerificationStep(session, 0);
    expect(reopened.steps[0].startedAt).toBe(10000);
  });

  it("out-of-bounds negative returns unchanged session", () => {
    const session = createTestSession();
    const result = reopenVerificationStep(session, -1);
    expect(result).toBe(session);
  });

  it("out-of-bounds too large returns unchanged session", () => {
    const session = createTestSession();
    const result = reopenVerificationStep(session, 99);
    expect(result).toBe(session);
  });

  it("out-of-bounds exactly at steps.length returns unchanged session", () => {
    const session = createTestSession();
    const result = reopenVerificationStep(session, session.steps.length);
    expect(result).toBe(session);
  });

  it("clears completedAt", () => {
    const session = createTestSession({ completedAt: 9000 });
    const reopened = reopenVerificationStep(session, 0);
    expect(reopened.completedAt).toBeNull();
  });

  it("does not modify other steps", () => {
    const session = createTestSession(
      {},
      [
        { result: "matched" },
        { result: "noSignal", notes: "No signal seen" },
        { result: "pending" },
      ],
    );

    const reopened = reopenVerificationStep(session, 0);

    expect(reopened.steps[1].result).toBe("noSignal");
    expect(reopened.steps[1].notes).toBe("No signal seen");
    expect(reopened.steps[2].result).toBe("pending");
  });
});

describe("createVerificationSessionExport", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(12000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it("contains version 1", () => {
    const session = createTestSession();
    const exported = createVerificationSessionExport(session);
    expect(exported.version).toBe(1);
  });

  it("contains generatedAt timestamp", () => {
    const session = createTestSession();
    const exported = createVerificationSessionExport(session);
    expect(exported.generatedAt).toBe(12000);
  });

  it("contains session and summary", () => {
    const session = createTestSession(
      {},
      [
        { result: "matched" },
        { result: "mismatched" },
        { result: "pending" },
      ],
    );

    const exported = createVerificationSessionExport(session);

    expect(exported.session).toBe(session);
    expect(exported.summary.total).toBe(3);
    expect(exported.summary.matched).toBe(1);
    expect(exported.summary.mismatched).toBe(1);
    expect(exported.summary.pending).toBe(1);
  });

  it("summary matches summarizeVerificationSession output", () => {
    const session = createTestSession(
      {},
      [
        { result: "matched" },
        { result: "skipped" },
        { result: "noSignal" },
      ],
    );

    const exported = createVerificationSessionExport(session);
    const directSummary = summarizeVerificationSession(session);

    expect(exported.summary).toEqual(directSummary);
  });
});

// ---------------------------------------------------------------------------
// Edge case: session with zero steps (boundary)
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("session with no steps: activeVerificationStep returns null", () => {
    const session = createTestSession({ steps: [], activeStepIndex: 0 });
    expect(activeVerificationStep(session)).toBeNull();
  });

  it("session with no steps: summarize returns all zeros", () => {
    const session = createTestSession({ steps: [] });
    const summary = summarizeVerificationSession(session);
    expect(summary.total).toBe(0);
    expect(summary.matched).toBe(0);
  });

  it("session with no steps: navigateToVerificationStep returns unchanged", () => {
    const session = createTestSession({ steps: [], activeStepIndex: 0 });
    const result = navigateToVerificationStep(session, 0);
    expect(result).toBe(session);
  });

  it("session with no steps: reopenVerificationStep returns unchanged", () => {
    const session = createTestSession({ steps: [], activeStepIndex: 0 });
    const result = reopenVerificationStep(session, 0);
    expect(result).toBe(session);
  });

  it("captureVerificationObservation: event exactly at startedAt is captured", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ startedAt: 5000 }, {}, {}],
    );

    const event = createEncodedKeyEvent({
      encodedKey: "F13",
      receivedAt: 5000,
    });

    const updated = captureVerificationObservation(session, event);
    expect(updated.steps[0].observedEncodedKey).toBe("F13");
  });

  it("navigateToVerificationStep to already-active index with pending unstarted step starts it", () => {
    const session = createTestSession(
      { activeStepIndex: 1 },
      [{}, { startedAt: null, result: "pending" }, {}],
    );

    vi.spyOn(Date, "now").mockReturnValue(15000);
    const navigated = navigateToVerificationStep(session, 1);

    expect(navigated.activeStepIndex).toBe(1);
    expect(navigated.steps[1].startedAt).toBe(15000);
  });

  it("finalizeVerificationStep with all result types", () => {
    vi.spyOn(Date, "now").mockReturnValue(20000);

    const results = ["matched", "mismatched", "noSignal", "skipped"] as const;
    for (const result of results) {
      const session = createTestSession({ activeStepIndex: 0 });
      const finalized = finalizeVerificationStep(session, result, null, null);
      expect(finalized.steps[0].result).toBe(result);
    }
  });

  it("createVerificationSession with only reserved controls returns null", () => {
    const config: AppConfig = {
      ...createTestConfig(),
      physicalControls: [
        createPhysicalControl("mouse_left", "topPanel", "reserved"),
        createPhysicalControl("mouse_right", "topPanel", "reserved"),
      ],
    };

    const session = createVerificationSession(
      config,
      "standard",
      null,
      null,
      "all",
    );
    expect(session).toBeNull();
  });

  it("createVerificationSession with currentFamily scope filters to selected family only", () => {
    vi.spyOn(Date, "now").mockReturnValue(3000);
    const config = createTestConfig();

    const session = createVerificationSession(
      config,
      "standard",
      null,
      "mouse_4",
      "currentFamily",
    );

    expect(session).not.toBeNull();
    // mouse_4 is topPanel family, so all steps should be topPanel
    expect(session!.steps.every((s) => s.family === "topPanel")).toBe(true);
    // mouse_left and mouse_right are reserved, should be filtered
    const ids = session!.steps.map((s) => s.controlId);
    expect(ids).not.toContain("mouse_left");
    expect(ids).not.toContain("mouse_right");
  });

  it("restartVerificationStep preserves notes", () => {
    const session = createTestSession(
      { activeStepIndex: 0 },
      [{ notes: "Important note", result: "mismatched" }, {}, {}],
    );

    const restarted = restartVerificationStep(session, 9000);
    // restartVerificationStep does NOT modify notes -- it only resets observation fields
    // Looking at the source: it spreads ...step first, then overrides specific fields
    // notes is NOT in the override list, so it's preserved from the spread
    expect(restarted.steps[0].notes).toBe("Important note");
  });
});
