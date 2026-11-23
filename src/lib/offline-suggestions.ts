import type { TFunction } from "i18next";
import type {
  Action,
  AppConfig,
  Binding,
  ControlId,
  Layer,
  MouseActionKind,
  OfflineLayer,
  ShortcutActionPayload,
} from "./config";
import { findBinding, gestureOf, setOfflineAssignment } from "./config-editing";
import { displayNameForControl, displayNameForControlId } from "./labels";
import { mouseActionLabel, modifierLabels } from "./action-helpers";
import { isOfflinePayloadPlayable } from "./action-picker-helpers";
import { layoutControlId } from "./devices";
import { playsWithoutSidearm, type OfflineControl, type OfflinePreview } from "./onboard-mapping";

export type OfflinePayload =
  | ShortcutActionPayload
  | Extract<Action, { type: "mouseAction" }>["payload"];

interface OfflineSuggestion {
  id: string;
  label: string;
  source: string;
  hint?: string;
  /** False when applying automatically would pick a keyboard layout or drop pressEnter. */
  autoApply: boolean;
  payload: OfflinePayload;
}

export interface OfflineFixItem {
  controlId: ControlId;
  controlLabel: string;
  layer: OfflineLayer;
  status: "silent" | "nativeFallback";
  liveLabel: string;
  currentOfflineLabel: string;
  suggestions: OfflineSuggestion[];
}

export interface OfflineFixPlan {
  items: OfflineFixItem[];
  ownCount: number;
}

const UNSHIFTED_ASCII = new Set([
  "-", "=", "[", "]", "\\", ";", "'", "`", ",", ".", "/",
]);

const SHIFTED_ASCII: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

function payloadSignature(payload: OfflinePayload): string {
  if ("action" in payload) {
    return `mouse:${payload.action}`;
  }
  return `key:${payload.ctrl ? 1 : 0}${payload.shift ? 1 : 0}${payload.alt ? 1 : 0}${payload.win ? 1 : 0}:${payload.key.toUpperCase()}`;
}

function payloadDisplayLabel(payload: OfflinePayload): string {
  if ("action" in payload) {
    return mouseActionLabel(payload.action) ?? payload.action;
  }
  return [...modifierLabels(payload), payload.key].filter(Boolean).join(" + ");
}

function liveLayerFor(layer: OfflineLayer): "standard" | "hypershift" {
  return layer === "offlineHypershift" ? "hypershift" : "standard";
}

/** Parse a `send` sequence step (e.g. "Ctrl+Shift+C", "Esc", "Ctrl+=") into a
 *  firmware-compatible shortcut payload, or null when unplayable in flash. */
function parseSequenceShortcut(value: string): ShortcutActionPayload | null {
  const raw = value.trim();
  if (!raw) return null;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let win = false;
  let key = "";
  const tokens: string[] = [];
  let buf = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "+" && buf.length > 0 && i < raw.length - 1) {
      tokens.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) tokens.push(buf.trim());
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "shift") shift = true;
    else if (lower === "alt") alt = true;
    else if (lower === "win" || lower === "meta" || lower === "super") win = true;
    else if (!key) key = token.length === 1 ? token.toUpperCase() : token;
    else return null;
  }
  const payload: ShortcutActionPayload = { key, ctrl, shift, alt, win };
  return isOfflinePayloadPlayable(payload) ? payload : null;
}

function sequenceSuggestions(
  action: Extract<Action, { type: "sequence" }>,
  t: TFunction,
): Array<{ source: string; hint?: string; autoApply: boolean; payload: ShortcutActionPayload }> {
  const activeSteps = action.payload.steps.filter((step) => step.type !== "sleep");
  if (activeSteps.length === 0) return [];
  const firstSend = activeSteps.find(
    (step): step is Extract<typeof step, { type: "send" }> => step.type === "send" && Boolean(step.value),
  );
  if (!firstSend) return [];
  const payload = parseSequenceShortcut(firstSend.value);
  if (!payload) return [];
  const firstSig = payloadSignature(payload);
  const allSameShortcut = activeSteps.every((step) => {
    if (step.type !== "send" || !step.value) return false;
    const parsed = parseSequenceShortcut(step.value);
    return parsed !== null && payloadSignature(parsed) === firstSig;
  });
  return [{
    source: t("offlineFix.sourceFromSequence"),
    hint: t(allSameShortcut ? "offlineFix.sequenceRepeatHint" : "offlineFix.sequenceFirstStepHint"),
    autoApply: allSameShortcut,
    payload,
  }];
}

function resolveSnippetText(config: AppConfig, action: Extract<Action, { type: "textSnippet" }>): string {
  const { payload } = action;
  if (payload.source === "libraryRef") {
    const snippetId = payload.snippetId;
    const item = config.snippetLibrary.find((entry) => entry.id === snippetId);
    return item?.text ?? "";
  }
  return payload.text;
}

function describeLiveAction(config: AppConfig, action: Action, t: TFunction): string {
  const typeLabel = t(`action.type.${action.type}`, { defaultValue: action.type });
  if (action.type === "textSnippet") {
    const text = resolveSnippetText(config, action).trim();
    const preview = text.length > 0 && text.length <= 24 ? text : action.displayName || text.slice(0, 24);
    return preview ? `${typeLabel}: ${preview}` : typeLabel;
  }
  if (action.type === "menu") {
    return action.displayName ? `${typeLabel}: ${action.displayName}` : typeLabel;
  }
  if (action.type === "mouseAction") {
    return action.displayName || mouseActionLabel(action.payload.action) || action.payload.action;
  }
  return action.displayName || typeLabel;
}

function findEnabledLiveBindings(
  config: AppConfig,
  profileId: string,
  controlId: ControlId,
  layer: Layer,
): Binding[] {
  return config.bindings.filter(
    (b) => b.enabled && b.profileId === profileId && b.controlId === controlId && b.layer === layer,
  );
}

function liveBindingAndAction(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
  layer: OfflineLayer,
): { binding: Binding; action: Action } | null {
  const wanted = liveLayerFor(layer);
  const pickFrom = (targetLayer: "standard" | "hypershift", allowGestureOnly: boolean) => {
    const bindings = findEnabledLiveBindings(config, profileId, controlId, targetLayer);
    const press = bindings.find((b) => gestureOf(b.triggerMode) === "press");
    const chosen = press ?? (allowGestureOnly ? bindings[0] : undefined);
    if (!chosen) return null;
    const action = actionsById.get(chosen.actionId);
    return action ? { binding: chosen, action } : null;
  };
  // Mirror Rust `mouse_offline::binding_action`: on HyperShift only a plain press
  // overrides Standard; a gesture-only HyperShift binding falls back to Standard.
  if (wanted === "hypershift") {
    return pickFrom("hypershift", false) ?? pickFrom("standard", true);
  }
  return pickFrom("standard", true);
}

function playablePayloadOf(binding: Binding, action: Action | undefined): OfflinePayload | null {
  if (!action || !playsWithoutSidearm(binding, action)) return null;
  if (action.type === "shortcut") {
    return {
      key: action.payload.key,
      ctrl: action.payload.ctrl,
      shift: action.payload.shift,
      alt: action.payload.alt,
      win: action.payload.win,
    };
  }
  if (action.type === "mouseAction") {
    return { action: action.payload.action };
  }
  return null;
}

function textSuggestions(
  text: string,
  pressEnter: boolean,
  t: TFunction,
): Array<{ label?: string; source: string; hint?: string; autoApply: boolean; payload: ShortcutActionPayload }> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2) return [];
  const out: Array<{ label?: string; source: string; hint?: string; autoApply: boolean; payload: ShortcutActionPayload }> = [];
  const appendEnterHint = (base?: string) => {
    if (!pressEnter) return base;
    const enterNote = t("offlineFix.pressEnterDroppedHint");
    return base ? `${base} ${enterNote}` : enterNote;
  };

  if (trimmed === "?") {
    out.push({
      label: "Shift + / (? · EN)",
      source: t("offlineFix.sourceKeyEn"),
      hint: appendEnterHint(t("offlineFix.layoutHintEn", { char: "?" })),
      autoApply: false,
      payload: { key: "/", ctrl: false, shift: true, alt: false, win: false },
    });
    out.push({
      label: "Shift + 7 (? · RU)",
      source: t("offlineFix.sourceKeyRu"),
      hint: appendEnterHint(t("offlineFix.layoutHintRu", { char: "?" })),
      autoApply: false,
      payload: { key: "7", ctrl: false, shift: true, alt: false, win: false },
    });
    return out;
  }

  if (trimmed === "–" || trimmed === "—") {
    out.push({
      label: "-",
      source: t("offlineFix.sourceClosestKey"),
      hint: appendEnterHint(t("offlineFix.dashHint")),
      autoApply: !pressEnter,
      payload: { key: "-", ctrl: false, shift: false, alt: false, win: false },
    });
    return out;
  }

  if (trimmed.length === 1) {
    if (/^[a-zA-Z]$/.test(trimmed)) {
      const upper = trimmed === trimmed.toUpperCase();
      out.push({
        source: t("offlineFix.sourceKey"),
        hint: appendEnterHint(t("offlineFix.layoutHintGeneric", { char: trimmed })),
        autoApply: false,
        payload: { key: trimmed.toUpperCase(), ctrl: false, shift: upper, alt: false, win: false },
      });
      return out;
    }
    if (/^[0-9]$/.test(trimmed) || UNSHIFTED_ASCII.has(trimmed)) {
      const layoutDependent = UNSHIFTED_ASCII.has(trimmed);
      out.push({
        source: t("offlineFix.sourceKey"),
        hint: appendEnterHint(layoutDependent ? t("offlineFix.layoutHintEn", { char: trimmed }) : undefined),
        autoApply: !layoutDependent && !pressEnter,
        payload: { key: trimmed, ctrl: false, shift: false, alt: false, win: false },
      });
      return out;
    }
    if (Object.hasOwn(SHIFTED_ASCII, trimmed)) {
      out.push({
        source: t("offlineFix.sourceKeyEn"),
        hint: appendEnterHint(t("offlineFix.layoutHintEn", { char: trimmed })),
        autoApply: false,
        payload: { key: SHIFTED_ASCII[trimmed], ctrl: false, shift: true, alt: false, win: false },
      });
    }
  }
  return out;
}

function mouseActionSuggestions(
  controlId: ControlId,
  action: Extract<Action, { type: "mouseAction" }>,
  standardOfflineSig: string | null,
  t: TFunction,
): Array<{ source: string; hint?: string; autoApply?: boolean; payload: OfflinePayload }> {
  const out: Array<{ source: string; hint?: string; autoApply?: boolean; payload: OfflinePayload }> = [];
  const kind = action.payload.action;
  const baseControl = layoutControlId(controlId);
  const { ctrl, shift, alt, win } = action.payload;

  // Ctrl + ScrollUp / ScrollDown is zoom in browsers, editors and office apps:
  // mouse firmware cannot send Ctrl+Wheel, but Ctrl + = / Ctrl + - works natively.
  if ((kind === "scrollUp" || kind === "scrollDown") && ctrl && !shift && !alt && !win) {
    out.push({
      source: t("offlineFix.sourceZoom"),
      hint: t("offlineFix.zoomHint"),
      autoApply: true,
      payload: { key: kind === "scrollUp" ? "=" : "-", ctrl: true, shift: false, alt: false, win: false },
    });
    const plain: Extract<Action, { type: "mouseAction" }>["payload"] = { action: kind };
    if (isOfflinePayloadPlayable(plain)) {
      out.push({
        source: t("offlineFix.sourceWithoutModifiers"),
        autoApply: false,
        payload: plain,
      });
    }
    return out;
  }

  // Shift + ScrollUp / ScrollDown is horizontal scroll: offer Left / Right arrows.
  if ((kind === "scrollUp" || kind === "scrollDown") && shift && !ctrl && !alt && !win) {
    out.push({
      source: t("offlineFix.sourceArrowKey"),
      autoApply: false,
      payload: { key: kind === "scrollUp" ? "Left" : "Right", ctrl: false, shift: false, alt: false, win: false },
    });
    const plain: Extract<Action, { type: "mouseAction" }>["payload"] = { action: kind };
    if (isOfflinePayloadPlayable(plain)) {
      out.push({
        source: t("offlineFix.sourceWithoutModifiers"),
        autoApply: false,
        payload: plain,
      });
    }
    return out;
  }

  if (kind === "scrollLeft" || kind === "scrollRight") {
    const isLeft = kind === "scrollLeft";
    const nativeClickPayload: OfflinePayload = { action: isLeft ? "mouseBack" : "mouseForward" };
    const arrowPayload: OfflinePayload = { key: isLeft ? "Left" : "Right", ctrl: false, shift: false, alt: false, win: false };
    const canSuggestNativeClick =
      baseControl === "mouse_4" || baseControl === "mouse_5" || baseControl === "wheel_left" || baseControl === "wheel_right";
    const nativeAlreadyOnStandard = standardOfflineSig === payloadSignature(nativeClickPayload);

    if (canSuggestNativeClick && !nativeAlreadyOnStandard) {
      out.push({
        source: t("offlineFix.sourceNativeClick"),
        payload: nativeClickPayload,
      });
      out.push({
        source: t("offlineFix.sourceArrowKey"),
        payload: arrowPayload,
      });
    } else {
      out.push({
        source: t("offlineFix.sourceArrowKey"),
        payload: arrowPayload,
      });
      if (canSuggestNativeClick) {
        out.push({
          source: t("offlineFix.sourceNativeClick"),
          hint: t("offlineFix.sameAsStandardHint"),
          autoApply: false,
          payload: nativeClickPayload,
        });
      }
    }
    return out;
  }

  // On wheel_click (middle button), Ctrl+LeftClick usually wants a plain middle click or plain left click.
  if (baseControl === "wheel_click" && kind === "leftClick") {
    out.push({
      source: t("offlineFix.sourceNativeClick"),
      payload: { action: "middleClick" },
    });
  }

  const plain: Extract<Action, { type: "mouseAction" }>["payload"] = { action: kind };
  if (isOfflinePayloadPlayable(plain)) {
    out.push({
      source: t("offlineFix.sourceWithoutModifiers"),
      payload: plain,
    });
  }
  return out;
}

function fallbackProfileSuggestion(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
  layer: OfflineLayer,
  t: TFunction,
): { source: string; payload: OfflinePayload } | null {
  const fallbackId = config.settings.fallbackProfileId;
  if (!fallbackId || fallbackId === profileId) return null;
  const fallbackProfile = config.profiles.find((p) => p.id === fallbackId);
  if (!fallbackProfile) return null;

  // Prefer fallback profile's own offline assignment on the same control+layer,
  // otherwise fall back to its playable live assignment.
  const ownOffline = findBinding(config, fallbackId, layer, controlId);
  if (ownOffline && ownOffline.enabled) {
    const ownAction = actionsById.get(ownOffline.actionId);
    const payload = playablePayloadOf(ownOffline, ownAction);
    if (payload) {
      return {
        source: t("offlineFix.sourceFromProfile", { name: fallbackProfile.name }),
        payload,
      };
    }
  }

  const live = liveBindingAndAction(config, actionsById, fallbackId, controlId, layer);
  if (live) {
    const payload = playablePayloadOf(live.binding, live.action);
    if (payload) {
      return {
        source: t("offlineFix.sourceFromProfile", { name: fallbackProfile.name }),
        payload,
      };
    }
  }
  return null;
}

function gesturePromotionSuggestion(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
  t: TFunction,
): { source: string; hint?: string; autoApply?: boolean; payload: OfflinePayload } | null {
  const standardBindings = findEnabledLiveBindings(config, profileId, controlId, "standard");
  const extraGestures = standardBindings.filter((b) => gestureOf(b.triggerMode) !== "press");
  const prioritized = [
    ...extraGestures.filter((b) => b.triggerMode === "longPress"),
    ...extraGestures.filter((b) => b.triggerMode === "hold"),
    ...extraGestures.filter((b) => b.triggerMode !== "longPress" && b.triggerMode !== "hold"),
  ];
  for (const gestureBinding of prioritized) {
    const action = actionsById.get(gestureBinding.actionId);
    if (!action) continue;
    const isHoldLike = gestureBinding.triggerMode === "longPress" || gestureBinding.triggerMode === "hold";
    const source = t(isHoldLike ? "offlineFix.sourceFromHold" : "offlineFix.sourceFromGesture");
    const asPlain: Binding = { ...gestureBinding, triggerMode: "press" };
    const payload = playablePayloadOf(asPlain, action);
    if (payload) {
      return { source, payload };
    }
    if (action.type === "sequence") {
      const seq = sequenceSuggestions(action, t)[0];
      if (seq) {
        return { source, hint: seq.hint, autoApply: seq.autoApply, payload: seq.payload };
      }
    }
  }
  return null;
}

function hypershift2Suggestion(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
  layer: OfflineLayer,
  t: TFunction,
): { source: string; payload: OfflinePayload } | null {
  if (layer !== "offlineHypershift") return null;
  const hs2Bindings = findEnabledLiveBindings(config, profileId, controlId, "hypershift2");
  const press = hs2Bindings.find((b) => gestureOf(b.triggerMode) === "press");
  if (!press) return null;
  const payload = playablePayloadOf(press, actionsById.get(press.actionId));
  if (!payload) return null;
  return {
    source: t("offlineFix.sourceFromHypershift2"),
    payload,
  };
}

/** Signature of what the offline Standard layer already plays on this control,
 *  used to avoid wasting an offlineHyperShift slot on an exact duplicate. */
function standardOfflinePayloadSignature(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
): string | null {
  const ownOffline = findBinding(config, profileId, "offline", controlId);
  if (ownOffline?.enabled) {
    const payload = playablePayloadOf(ownOffline, actionsById.get(ownOffline.actionId));
    return payload ? payloadSignature(payload) : null;
  }
  const standardBindings = findEnabledLiveBindings(config, profileId, controlId, "standard");
  const press = standardBindings.find((b) => gestureOf(b.triggerMode) === "press");
  if (press) {
    const payload = playablePayloadOf(press, actionsById.get(press.actionId));
    return payload ? payloadSignature(payload) : null;
  }
  const baseControl = layoutControlId(controlId);
  if (baseControl === "wheel_up") return payloadSignature({ action: "scrollUp" });
  if (baseControl === "wheel_down") return payloadSignature({ action: "scrollDown" });
  return null;
}

function standardLayerSuggestion(
  config: AppConfig,
  actionsById: Map<string, Action>,
  profileId: string,
  controlId: ControlId,
  layer: OfflineLayer,
  t: TFunction,
): { source: string; hint?: string; autoApply: boolean; payload: OfflinePayload } | null {
  if (layer !== "offlineHypershift") return null;
  const standardBindings = findEnabledLiveBindings(config, profileId, controlId, "standard");
  const press = standardBindings.find((b) => gestureOf(b.triggerMode) === "press");
  if (!press) return null;
  const payload = playablePayloadOf(press, actionsById.get(press.actionId));
  if (!payload) return null;
  return {
    source: t("offlineFix.sourceFromStandard"),
    hint: t("offlineFix.sameAsStandardHint"),
    autoApply: false,
    payload,
  };
}

function controlNeedsFix(
  control: OfflineControl,
  live: { binding: Binding; action: Action } | null,
): "silent" | "nativeFallback" | null {
  if (!control.editable) return null;
  // User explicitly muted it with their own offline binding — respect their choice.
  if (control.kind === "own") return null;
  if (control.kind === "silent") {
    // Ignore explicit Disabled live actions (user intentionally disabled the button).
    if (live?.action.type === "disabled") return null;
    return "silent";
  }
  // Native fallback on V2 (e.g. mouse_4 had TextSnippet "?" under HyperShift and silently
  // reverted to native mouseBack): flag it so the user sees it and can replace it cleanly.
  if (control.kind === "inherited" && !control.actionId && control.native && live && !playsWithoutSidearm(live.binding, live.action)) {
    return "nativeFallback";
  }
  return null;
}

/** Build the per-profile list of buttons that do not play their Sidearm action
 *  without Sidearm, together with ranked 1-click firmware-compatible replacements. */
export function buildOfflineFixPlan(
  config: AppConfig,
  profileId: string,
  deviceId: string,
  preview: OfflinePreview | null,
  t: TFunction,
): OfflineFixPlan {
  if (!preview) return { items: [], ownCount: 0 };
  const actionsById = new Map(config.actions.map((action) => [action.id, action]));
  const controlsById = new Map(config.physicalControls.map((c) => [c.id, c]));

  let ownCount = 0;
  const items: OfflineFixItem[] = [];

  for (const entry of preview.controls) {
    const physical = controlsById.get(entry.controlId);
    if (physical && physical.deviceId !== deviceId) continue;
    // Respect ANY explicit enabled offline override (including intentional "Silent"/disabled mutes,
    // which Rust previews with kind === "silent" rather than "own").
    const explicitOffline = findBinding(config, profileId, entry.layer, entry.controlId);
    if (entry.kind === "own" || explicitOffline?.enabled) {
      ownCount += 1;
      continue;
    }

    const live = liveBindingAndAction(config, actionsById, profileId, entry.controlId, entry.layer);
    const status = controlNeedsFix(entry, live);
    if (!status || !live) continue;

    const standardOfflineSig = entry.layer === "offlineHypershift"
      ? standardOfflinePayloadSignature(config, actionsById, profileId, entry.controlId)
      : null;

    const seen = new Set<string>();
    const distinctSuggestions: OfflineSuggestion[] = [];
    const duplicateSuggestions: OfflineSuggestion[] = [];
    const push = (
      candidate: { label?: string; source: string; hint?: string; autoApply?: boolean; payload: OfflinePayload } | null,
    ) => {
      if (!candidate || !isOfflinePayloadPlayable(candidate.payload)) return;
      const sig = payloadSignature(candidate.payload);
      if (seen.has(sig)) return;
      seen.add(sig);
      const duplicatesStandard = standardOfflineSig !== null && sig === standardOfflineSig;
      const item: OfflineSuggestion = {
        id: sig,
        label: candidate.label ?? payloadDisplayLabel(candidate.payload),
        source: candidate.source,
        hint: candidate.hint ?? (duplicatesStandard ? t("offlineFix.sameAsStandardHint") : undefined),
        autoApply: duplicatesStandard ? false : (candidate.autoApply ?? true),
        payload: candidate.payload,
      };
      if (duplicatesStandard) duplicateSuggestions.push(item);
      else distinctSuggestions.push(item);
    };

    if (live.action.type === "textSnippet") {
      const text = resolveSnippetText(config, live.action);
      const pressEnter = Boolean(live.action.payload.pressEnter);
      for (const candidate of textSuggestions(text, pressEnter, t)) push(candidate);
    } else if (live.action.type === "mouseAction") {
      for (const candidate of mouseActionSuggestions(entry.controlId, live.action, standardOfflineSig, t)) push(candidate);
    } else if (live.action.type === "sequence") {
      for (const candidate of sequenceSuggestions(live.action, t)) push(candidate);
    }

    push(fallbackProfileSuggestion(config, actionsById, profileId, entry.controlId, entry.layer, t));
    push(gesturePromotionSuggestion(config, actionsById, profileId, entry.controlId, t));
    push(hypershift2Suggestion(config, actionsById, profileId, entry.controlId, entry.layer, t));

    const suggestions = distinctSuggestions.length > 0 ? [...distinctSuggestions] : [...duplicateSuggestions];
    // Only suggest copying from the same profile's Standard layer when no better
    // replacement (from text/mouse/sequence, fallback profile, gesture, or HS2) was found.
    if (suggestions.length === 0) {
      push(standardLayerSuggestion(config, actionsById, profileId, entry.controlId, entry.layer, t));
      suggestions.push(...distinctSuggestions, ...duplicateSuggestions);
    }

    const controlLabel = physical
      ? displayNameForControl(physical, "i18n")
      : displayNameForControlId(entry.controlId);
    const currentOfflineLabel = status === "nativeFallback" && entry.native
      ? t("offlineFix.statusFallback", { action: mouseActionLabel(entry.native as MouseActionKind) ?? entry.native })
      : t("offline.silentAction");

    items.push({
      controlId: entry.controlId,
      controlLabel,
      layer: entry.layer,
      status,
      liveLabel: describeLiveAction(config, live.action, t),
      currentOfflineLabel,
      suggestions: suggestions.slice(0, 3),
    });
  }

  return { items, ownCount };
}

/** Apply one suggested firmware-compatible replacement to the button's offline layer. */
export function applyOfflineSuggestion(
  config: AppConfig,
  profileId: string,
  controlId: ControlId,
  layer: OfflineLayer,
  payload: OfflinePayload,
): AppConfig {
  return setOfflineAssignment(config, profileId, controlId, layer, payload);
}

/** Apply the top unambiguous auto-applicable suggestion for every item that has one. */
export function applyAllOfflineSuggestions(
  config: AppConfig,
  profileId: string,
  items: readonly OfflineFixItem[],
): { config: AppConfig; applied: number } {
  let next = config;
  let applied = 0;
  for (const item of items) {
    const first = item.suggestions.find((s) => s.autoApply);
    if (!first) continue;
    next = setOfflineAssignment(next, profileId, item.controlId, item.layer, first.payload);
    applied += 1;
  }
  return { config: next, applied };
}

/** Copy firmware-playable offline replacements from the fallback profile for
 *  every control/layer in `items` that does not yet have an explicit offline override. */
export function copyOfflineLayerFromFallback(
  config: AppConfig,
  profileId: string,
  items: readonly OfflineFixItem[],
): { config: AppConfig; copied: number } {
  const fallbackId = config.settings.fallbackProfileId;
  if (!fallbackId || fallbackId === profileId) {
    return { config, copied: 0 };
  }
  const actionsById = new Map(config.actions.map((action) => [action.id, action]));
  let next = config;
  let copied = 0;
  for (const item of items) {
    const explicit = findBinding(next, profileId, item.layer, item.controlId);
    if (explicit?.enabled) continue;
    const ownOffline = findBinding(next, fallbackId, item.layer, item.controlId);
    const liveCandidate = liveBindingAndAction(next, actionsById, fallbackId, item.controlId, item.layer);
    const chosen = ownOffline?.enabled
      ? { binding: ownOffline, action: actionsById.get(ownOffline.actionId) }
      : liveCandidate;
    if (!chosen?.action || !playsWithoutSidearm(chosen.binding, chosen.action)) continue;
    if (chosen.action.type !== "shortcut" && chosen.action.type !== "mouseAction") continue;
    const payload = chosen.action.payload as OfflinePayload;
    if (!isOfflinePayloadPlayable(payload)) continue;
    next = setOfflineAssignment(next, profileId, item.controlId, item.layer, payload);
    copied += 1;
  }
  return { config: next, copied };
}

/** Remove all explicit offline (`offline` and `offlineHypershift`) overrides
 *  for `profileId` on `deviceId`. */
export function resetAllOfflineOverrides(
  config: AppConfig,
  profileId: string,
  deviceId: string,
): { config: AppConfig; removed: number } {
  const deviceControls = new Set(
    config.physicalControls.filter((c) => c.deviceId === deviceId).map((c) => c.id),
  );
  const targets = config.bindings.filter(
    (b) =>
      b.profileId === profileId
      && (b.layer === "offline" || b.layer === "offlineHypershift")
      && deviceControls.has(b.controlId),
  );
  if (targets.length === 0) return { config, removed: 0 };
  let next = config;
  for (const binding of targets) {
    next = setOfflineAssignment(next, profileId, binding.controlId, binding.layer as OfflineLayer, null);
  }
  return { config: next, removed: targets.length };
}
