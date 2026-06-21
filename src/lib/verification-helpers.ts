import i18n from "../i18n";
import type { ControlId } from "./config";
import type {
  VerificationSession,
  VerificationStepResult,
} from "./verification-session";

export function describeVerificationAlignment(
  expectedEncodedKey: string | null,
  configuredEncodedKey: string | null,
  observedEncodedKey: string | null,
  observedMatchesSelectedControl: boolean,
): { title: string; body: string; noticeClass: string } {
  if (!expectedEncodedKey && !configuredEncodedKey) {
    return {
      title: i18n.t("verification.align.noConfigTitle"),
      body: i18n.t("verification.align.noConfigBody"),
      noticeClass: "notice--info",
    };
  }

  if (!configuredEncodedKey && expectedEncodedKey) {
    return {
      title: i18n.t("verification.align.notConfiguredTitle"),
      body: i18n.t("verification.align.notConfiguredBody", { key: expectedEncodedKey }),
      noticeClass: "notice--warning",
    };
  }

  if (
    expectedEncodedKey &&
    configuredEncodedKey &&
    expectedEncodedKey !== configuredEncodedKey
  ) {
    return {
      title: i18n.t("verification.align.mismatchTitle"),
      body: i18n.t("verification.align.mismatchBody", {
        configured: configuredEncodedKey,
        expected: expectedEncodedKey,
      }),
      noticeClass: "notice--warning",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey === configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: i18n.t("verification.align.okTitle"),
      body: i18n.t("verification.align.okBody", { observed: observedEncodedKey }),
      noticeClass: "notice--ok",
    };
  }

  if (
    observedEncodedKey &&
    configuredEncodedKey &&
    observedEncodedKey !== configuredEncodedKey &&
    observedMatchesSelectedControl
  ) {
    return {
      title: i18n.t("verification.align.observedDiffTitle"),
      body: i18n.t("verification.align.observedDiffBody", {
        observed: observedEncodedKey,
        configured: configuredEncodedKey,
      }),
      noticeClass: "notice--warning",
    };
  }

  return {
    title: i18n.t("verification.align.readyTitle"),
    body: i18n.t("verification.align.readyBody"),
    noticeClass: "notice--subtle",
  };
}


export function describeVerificationSessionSuggestion(
  result: Exclude<VerificationStepResult, "pending">,
  step: VerificationSession["steps"][number],
): string {
  switch (result) {
    case "matched":
      return i18n.t("verification.suggest.matched", { observed: step.observedEncodedKey });
    case "mismatched":
      return step.observedEncodedKey
        ? i18n.t("verification.suggest.mismatchedWithKey", { observed: step.observedEncodedKey })
        : i18n.t("verification.suggest.mismatchedNoKey");
    case "noSignal":
      return i18n.t("verification.suggest.noSignal");
    case "skipped":
      return i18n.t("verification.suggest.skipped");
  }
}

/** i18n KEY per control with a physical-location hint. Mirrors the
 *  `control.hint.*` namespace; a control absent here has no hint. */
const CONTROL_HINT_KEYS: Partial<Record<ControlId, string>> = {
  thumb_01: "control.hint.thumb_01",
  thumb_02: "control.hint.thumb_02",
  thumb_03: "control.hint.thumb_03",
  thumb_04: "control.hint.thumb_04",
  thumb_05: "control.hint.thumb_05",
  thumb_06: "control.hint.thumb_06",
  thumb_07: "control.hint.thumb_07",
  thumb_08: "control.hint.thumb_08",
  thumb_09: "control.hint.thumb_09",
  thumb_10: "control.hint.thumb_10",
  thumb_11: "control.hint.thumb_11",
  thumb_12: "control.hint.thumb_12",
  mouse_left: "control.hint.mouse_left",
  mouse_right: "control.hint.mouse_right",
  mouse_4: "control.hint.mouse_4",
  mouse_5: "control.hint.mouse_5",
  top_aux_01: "control.hint.top_aux_01",
  top_aux_02: "control.hint.top_aux_02",
  wheel_up: "control.hint.wheel_up",
  wheel_down: "control.hint.wheel_down",
  wheel_click: "control.hint.wheel_click",
  wheel_left: "control.hint.wheel_left",
  wheel_right: "control.hint.wheel_right",
  hypershift_button: "control.hint.hypershift_button",
};

/** Physical-location hint for a control, resolved via i18n. `undefined` for
 *  controls without a hint (preserves the old `Partial<Record>` semantics). */
export function controlPhysicalHintFor(controlId: ControlId): string | undefined {
  const key = CONTROL_HINT_KEYS[controlId];
  return key ? i18n.t(key) : undefined;
}

export function dotLabel(controlId: string): string {
  const thumbMatch = controlId.match(/^thumb_(\d+)$/);
  if (thumbMatch) return thumbMatch[1].replace(/^0/, "");
  const labels: Record<string, string> = {
    mouse_4: "←",
    mouse_5: "→",
    wheel_up: "↑",
    wheel_down: "↓",
    wheel_click: "⊙",
    top_aux_01: "D+",
    top_aux_02: "D−",
  };
  return labels[controlId] ?? "?";
}

export function verificationResultColor(result: VerificationStepResult): string {
  switch (result) {
    case "matched":
      return "var(--c-ok)";
    case "mismatched":
      return "var(--c-danger)";
    case "noSignal":
      return "var(--c-warning)";
    case "skipped":
      return "var(--c-text-muted)";
    case "pending":
      return "var(--c-border)";
  }
}
