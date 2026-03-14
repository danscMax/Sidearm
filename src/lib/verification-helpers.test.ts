import { describe, it, expect } from "vitest";
import type { ControlId } from "./config";
import type { VerificationStepResult } from "./verification-session";
import {
  describeVerificationAlignment,
  describeVerificationSessionSuggestion,
  dotLabel,
  verificationResultColor,
} from "./verification-helpers";

// ---------------------------------------------------------------------------
// describeVerificationAlignment
// ---------------------------------------------------------------------------

describe("describeVerificationAlignment", () => {
  it("returns info notice when neither expected nor configured", () => {
    const result = describeVerificationAlignment(null, null, null, false);
    expect(result.noticeClass).toBe("notice--info");
    expect(result.title).toContain("не задан");
  });

  it("returns warning when expected exists but configured is missing", () => {
    const result = describeVerificationAlignment("key1", null, null, false);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("key1");
  });

  it("returns warning when expected and configured mismatch", () => {
    const result = describeVerificationAlignment("expected", "configured", null, false);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("expected");
    expect(result.body).toContain("configured");
  });

  it("returns ok when observed matches configured and matches selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "key1", true);
    expect(result.noticeClass).toBe("notice--ok");
    expect(result.body).toContain("key1");
  });

  it("returns warning when observed differs from configured but matches selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "other", true);
    expect(result.noticeClass).toBe("notice--warning");
    expect(result.body).toContain("other");
    expect(result.body).toContain("key1");
  });

  it("returns subtle when configured exists but no observation yet", () => {
    const result = describeVerificationAlignment("key1", "key1", null, false);
    expect(result.noticeClass).toBe("notice--subtle");
    expect(result.title).toContain("готов");
  });

  it("returns subtle when configured exists and observed does not match selected control", () => {
    const result = describeVerificationAlignment("key1", "key1", "key1", false);
    expect(result.noticeClass).toBe("notice--subtle");
  });
});

// ---------------------------------------------------------------------------
// describeVerificationSessionSuggestion
// ---------------------------------------------------------------------------

describe("describeVerificationSessionSuggestion", () => {
  const baseStep = {
    controlId: "thumb_01" as ControlId,
    controlLabel: "Thumb 1",
    family: "thumbGrid" as const,
    layer: "standard" as const,
    capabilityStatus: "verified" as const,
    expectedEncodedKey: "key1",
    configuredEncodedKey: "key1",
    startedAt: 1000,
    observedEncodedKey: null as string | null,
    observedAt: null as number | null,
    observedBackend: null as string | null,
    activeExe: null as string | null,
    activeWindowTitle: null as string | null,
    resolutionStatus: null as null,
    resolvedControlId: null as ControlId | null,
    resolvedLayer: null as null,
    result: "pending" as VerificationStepResult,
    notes: "",
  };

  it("returns matched suggestion when observed key is present", () => {
    const step = { ...baseStep, observedEncodedKey: "key1" };
    const result = describeVerificationSessionSuggestion("matched", step);
    expect(result).toContain("key1");
    expect(result).toContain("совпал");
  });

  it("returns mismatched suggestion with observed key", () => {
    const step = { ...baseStep, observedEncodedKey: "wrong" };
    const result = describeVerificationSessionSuggestion("mismatched", step);
    expect(result).toContain("wrong");
  });

  it("returns mismatched suggestion without observed key", () => {
    const result = describeVerificationSessionSuggestion("mismatched", baseStep);
    expect(result).toContain("не дало чистого совпадения");
  });

  it("returns noSignal suggestion", () => {
    const result = describeVerificationSessionSuggestion("noSignal", baseStep);
    expect(result).toContain("не увидело нового сигнала");
  });

  it("returns skipped suggestion", () => {
    const result = describeVerificationSessionSuggestion("skipped", baseStep);
    expect(result).toContain("пропущен");
  });
});

// ---------------------------------------------------------------------------
// dotLabel
// ---------------------------------------------------------------------------

describe("dotLabel", () => {
  it("returns numeric label for thumb_01 through thumb_12", () => {
    expect(dotLabel("thumb_01")).toBe("1");
    expect(dotLabel("thumb_02")).toBe("2");
    expect(dotLabel("thumb_10")).toBe("10");
    expect(dotLabel("thumb_11")).toBe("11");
    expect(dotLabel("thumb_12")).toBe("12");
  });

  it("strips leading zero from thumb buttons", () => {
    expect(dotLabel("thumb_09")).toBe("9");
  });

  it("returns correct label for mouse_4", () => {
    expect(dotLabel("mouse_4")).toBe("←");
  });

  it("returns correct label for mouse_5", () => {
    expect(dotLabel("mouse_5")).toBe("→");
  });

  it("returns correct label for wheel_up", () => {
    expect(dotLabel("wheel_up")).toBe("↑");
  });

  it("returns correct label for wheel_down", () => {
    expect(dotLabel("wheel_down")).toBe("↓");
  });

  it("returns correct label for wheel_click", () => {
    expect(dotLabel("wheel_click")).toBe("⊙");
  });

  it("returns correct label for top_aux_01", () => {
    expect(dotLabel("top_aux_01")).toBe("D+");
  });

  it("returns correct label for top_aux_02", () => {
    expect(dotLabel("top_aux_02")).toBe("D−");
  });

  it("returns ? for unknown controls", () => {
    expect(dotLabel("unknown_control")).toBe("?");
  });

  it("returns ? for mouse_left (not in dot label map)", () => {
    expect(dotLabel("mouse_left")).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// verificationResultColor
// ---------------------------------------------------------------------------

describe("verificationResultColor", () => {
  it("returns ok color for matched", () => {
    expect(verificationResultColor("matched")).toBe("var(--c-ok)");
  });

  it("returns danger color for mismatched", () => {
    expect(verificationResultColor("mismatched")).toBe("var(--c-danger)");
  });

  it("returns warning color for noSignal", () => {
    expect(verificationResultColor("noSignal")).toBe("var(--c-warning)");
  });

  it("returns muted color for skipped", () => {
    expect(verificationResultColor("skipped")).toBe("var(--c-text-muted)");
  });

  it("returns border color for pending", () => {
    expect(verificationResultColor("pending")).toBe("var(--c-border)");
  });
});
