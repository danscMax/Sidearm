import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TFunction } from "i18next";
import type {
  Action,
  ActionCondition,
  ActionType,
  Binding,
  MediaKeyKind,
  MenuItem,
  MouseActionKind,
  PasteMode,
  Profile,
  SequenceStep,
  ShortcutActionPayload,
  TriggerMode,
} from "./config";
import { ACTION_CATEGORIES } from "./constants";
import { mediaKeyLabel, modifierLabels, mouseActionLabel } from "./action-helpers";

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
export function resolveKeyName(event: KeyboardEvent | ReactKeyboardEvent): string {
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

export function normalizeKeyName(key: string): string {
  return KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/* ─────────────────────────────────────────────────────────
   Condition Types
   ───────────────────────────────────────────────────────── */

export const CONDITION_TYPE_KEYS: Array<{ value: ActionCondition["type"]; key: string }> = [
  { value: "windowTitleContains", key: "picker.conditionWindowTitleContains" },
  { value: "windowTitleNotContains", key: "picker.conditionWindowTitleNotContains" },
  { value: "exeEquals", key: "picker.conditionExeEquals" },
  { value: "exeNotEquals", key: "picker.conditionExeNotEquals" },
];

/* ─────────────────────────────────────────────────────────
   Picker draft state
   ───────────────────────────────────────────────────────── */

/** Modifier-bearing mouse draft (mirrors MouseActionPayload but with all
 *  modifiers required as booleans, matching the picker's local state). */
export interface MouseDraft {
  action: MouseActionKind;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  win: boolean;
}

/** Snapshot of all per-category draft state held by ActionPickerModal.
 *  Passed to the pure builders so they stay free of React state. */
export interface PickerDrafts {
  shortcut: ShortcutActionPayload;
  mouse: MouseDraft;
  text: { text: string; pasteMode: PasteMode };
  launch: { target: string; args: string[]; workingDir: string };
  media: MediaKeyKind;
  profile: string;
  sequence: SequenceStep[];
  menuItems: MenuItem[];
  name: string;
  conditions: ActionCondition[];
}

/* ─────────────────────────────────────────────────────────
   Auto-naming
   ───────────────────────────────────────────────────────── */

/** Default human-readable name for an action when the user leaves the name
 *  field empty. Pure: depends only on drafts, translations, and profiles. */
export function autoName(
  actionType: ActionType,
  drafts: PickerDrafts,
  t: TFunction,
  profiles: Profile[],
): string {
  switch (actionType) {
    case "shortcut": {
      const parts = [...modifierLabels(drafts.shortcut), drafts.shortcut.key || null].filter(Boolean);
      return parts.length > 0 ? parts.join(" + ") : t("picker.autoShortcut");
    }
    case "mouseAction": {
      const mods = modifierLabels(drafts.mouse);
      const actionLabel = mouseActionLabel(drafts.mouse.action) ?? t("picker.autoMouse");
      return mods.length > 0 ? `${mods.join(" + ")} + ${actionLabel}` : actionLabel;
    }
    case "textSnippet":
      return drafts.text.text.slice(0, 30) || t("picker.autoText");
    case "sequence":
      return t("picker.autoMacro");
    case "launch":
      return drafts.launch.target.split(/[/\\]/).pop() ?? t("sequence.launch");
    case "mediaKey":
      return mediaKeyLabel(drafts.media) ?? t("action.type.mediaKey");
    case "profileSwitch": {
      const p = profiles.find((pr) => pr.id === drafts.profile);
      return p ? t("picker.autoProfile", { name: p.name }) : t("picker.autoProfileFallback");
    }
    case "menu":
      return t("picker.defaultMenu");
    case "disabled":
      return t("picker.defaultDisabled");
    case "repairClipboard":
      return t("action.type.repairClipboard");
    default:
      return t("picker.defaultAction");
  }
}

/* ─────────────────────────────────────────────────────────
   Action assembly
   ───────────────────────────────────────────────────────── */

/** Build the Action object from the current drafts and the selected category.
 *  Preserves existing inline textSnippet tags and drops blank conditions. */
export function buildAction(params: {
  effectiveCategory: string;
  existingAction: Action | null;
  drafts: PickerDrafts;
  t: TFunction;
  profiles: Profile[];
}): Action {
  const { effectiveCategory, existingAction, drafts, t, profiles } = params;
  const category = ACTION_CATEGORIES.find((c) => c.id === effectiveCategory) ?? ACTION_CATEGORIES[0];
  const actionType = category.actionType;
  const actionId = existingAction?.id ?? `action-picker-${Date.now()}`;
  const displayName = drafts.name.trim() || autoName(actionType, drafts, t, profiles);
  const validConditions = drafts.conditions.filter((c) => c.value.trim());

  const base: Action = (() => {
    switch (actionType) {
      case "shortcut":
        return { id: actionId, type: "shortcut" as const, payload: drafts.shortcut, displayName };
      case "mouseAction":
        return {
          id: actionId,
          type: "mouseAction" as const,
          payload: {
            action: drafts.mouse.action,
            ...(drafts.mouse.ctrl && { ctrl: true }),
            ...(drafts.mouse.shift && { shift: true }),
            ...(drafts.mouse.alt && { alt: true }),
            ...(drafts.mouse.win && { win: true }),
          },
          displayName,
        };
      case "textSnippet": {
        // Audit F039: the picker has no editor for library-referenced snippets,
        // so a libraryRef seeds an empty inline draft. Without this guard saving
        // would overwrite the reference with empty inline text, losing snippetId
        // and content. When editing a libraryRef and the draft text is still
        // empty (nothing was typed), keep the original reference intact.
        if (
          existingAction?.type === "textSnippet" &&
          existingAction.payload.source === "libraryRef" &&
          !drafts.text.text.trim()
        ) {
          return { ...existingAction, displayName };
        }
        // Preserve tags from existing inline payload so editing the text
        // through this picker doesn't silently drop tag metadata that was
        // set elsewhere.
        const preservedTags =
          existingAction?.type === "textSnippet" &&
          existingAction.payload.source === "inline"
            ? existingAction.payload.tags
            : [];
        return {
          id: actionId,
          type: "textSnippet" as const,
          payload: {
            source: "inline" as const,
            text: drafts.text.text,
            pasteMode: drafts.text.pasteMode,
            tags: preservedTags,
          },
          displayName,
        };
      }
      case "sequence":
        return { id: actionId, type: "sequence" as const, payload: { steps: drafts.sequence }, displayName };
      case "launch":
        return {
          id: actionId,
          type: "launch" as const,
          payload: {
            target: drafts.launch.target,
            args: drafts.launch.args.length > 0 ? drafts.launch.args : undefined,
            workingDir: drafts.launch.workingDir.trim() ? drafts.launch.workingDir.trim() : undefined,
          },
          displayName,
        };
      case "mediaKey":
        return { id: actionId, type: "mediaKey" as const, payload: { key: drafts.media }, displayName };
      case "profileSwitch":
        return { id: actionId, type: "profileSwitch" as const, payload: { targetProfileId: drafts.profile }, displayName };
      case "menu":
        return { id: actionId, type: "menu" as const, payload: { items: drafts.menuItems }, displayName: displayName || t("picker.defaultMenu") };
      case "disabled":
        return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, displayName: displayName || t("picker.defaultDisabled") };
      case "repairClipboard":
        return { id: actionId, type: "repairClipboard" as const, payload: { strategy: "latin1" as const }, displayName };
      default:
        return { id: actionId, type: "disabled" as const, payload: {} as Record<string, never>, displayName: t("picker.defaultDisabled") };
    }
  })();

  return validConditions.length > 0 ? { ...base, conditions: validConditions } : base;
}

/* ─────────────────────────────────────────────────────────
   Initial draft state
   ───────────────────────────────────────────────────────── */

/** All draft values the picker seeds on open, plus the binding-level trigger
 *  fields. Derived purely from the edited action/binding and profile list. */
export interface InitialPickerState extends PickerDrafts {
  triggerMode: TriggerMode;
  chordPartner: string;
}

/** Seed every picker draft from the action being edited (or sensible defaults
 *  for a new action). Pure: no React, no storage — just data in, data out. */
export function createInitialDrafts(
  existingAction: Action | null,
  binding: Binding | null,
  profiles: Profile[],
): InitialPickerState {
  return {
    shortcut:
      existingAction?.type === "shortcut"
        ? existingAction.payload
        : { key: "", ctrl: false, shift: false, alt: false, win: false },
    mouse:
      existingAction?.type === "mouseAction"
        ? {
            action: existingAction.payload.action,
            ctrl: existingAction.payload.ctrl ?? false,
            shift: existingAction.payload.shift ?? false,
            alt: existingAction.payload.alt ?? false,
            win: existingAction.payload.win ?? false,
          }
        : { action: "leftClick", ctrl: false, shift: false, alt: false, win: false },
    text:
      existingAction?.type === "textSnippet" && existingAction.payload.source === "inline"
        ? { text: existingAction.payload.text, pasteMode: existingAction.payload.pasteMode }
        : { text: "", pasteMode: "sendText" },
    launch:
      existingAction?.type === "launch"
        ? {
            target: existingAction.payload.target,
            args: existingAction.payload.args ?? [],
            workingDir: existingAction.payload.workingDir ?? "",
          }
        : { target: "", args: [], workingDir: "" },
    media: existingAction?.type === "mediaKey" ? existingAction.payload.key : "playPause",
    profile:
      existingAction?.type === "profileSwitch"
        ? existingAction.payload.targetProfileId
        : profiles[0]?.id ?? "",
    sequence:
      existingAction?.type === "sequence"
        ? existingAction.payload.steps
        : [{ type: "send", value: "Ctrl+C" }],
    menuItems: existingAction?.type === "menu" ? existingAction.payload.items : [],
    name: existingAction?.displayName ?? "",
    conditions: existingAction?.conditions ?? [],
    triggerMode: binding?.triggerMode ?? "press",
    chordPartner: binding?.chordPartner ?? "",
  };
}

/* ─────────────────────────────────────────────────────────
   Save gating
   ───────────────────────────────────────────────────────── */

/** Whether the Save button is disabled for the active category — shortcut needs
 *  a key or modifier, text needs content, launch needs a target. */
export function isSaveDisabled(effectiveCategory: string, drafts: PickerDrafts): boolean {
  if (effectiveCategory === "shortcut") {
    const s = drafts.shortcut;
    return !s.key && !s.ctrl && !s.shift && !s.alt && !s.win;
  }
  if (effectiveCategory === "textSnippet") return !drafts.text.text.trim();
  if (effectiveCategory === "launch") return !drafts.launch.target.trim();
  // Audit F005: an empty menu passes the backend schema check only to be rejected by
  // validate_action (menu must have >=1 item), which rolls back the whole draft. Block
  // Save here so the user keeps their work instead of losing it to a backend error.
  if (effectiveCategory === "menu") return drafts.menuItems.length === 0;
  return false;
}
