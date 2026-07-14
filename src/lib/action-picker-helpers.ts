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
  SnippetLibraryItem,
  TriggerMode,
} from "./config";
import { ACTION_CATEGORIES } from "./constants";
import { mediaKeyLabel, modifierLabels, mouseActionLabel } from "./action-helpers";
import { assertNever } from "./assertNever";

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
  // Guard against inherited Object.prototype members ("toString", "valueOf", …):
  // a bare `KEY_NAME_MAP[key]` would return those functions instead of falling
  // through, so look the key up only as an own property.
  if (Object.hasOwn(KEY_NAME_MAP, key)) return KEY_NAME_MAP[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Layout-independent accelerator key derived from a KeyboardEvent.code (physical
 *  position), so Shift+Alt+T yields "t" on ANY keyboard layout — unlike event.key,
 *  which is a Cyrillic letter on a Russian layout and invalid for a Tauri shortcut.
 *  Returns null for modifier-only or unsupported codes so the caller ignores them. */
export function acceleratorKeyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
}

/** Serialize a captured keyboard chord into a Tauri global-shortcut accelerator
 *  string (e.g. "ctrl+alt+n"). The Windows/Meta key maps to Tauri's "super"
 *  token; the key is lowercased. Modifier order is fixed (ctrl, shift, alt, super)
 *  so equal chords always serialize identically. */
export function serializeAccelerator(chord: {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  win: boolean;
  key: string;
}): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.shift) parts.push("shift");
  if (chord.alt) parts.push("alt");
  if (chord.win) parts.push("super");
  parts.push(chord.key.toLowerCase());
  return parts.join("+");
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
  // `snippetId` set => the action links to a library snippet (source: libraryRef);
  // `text` then holds the resolved snippet text for preview only. Editing the text
  // clears `snippetId`, detaching the button into its own inline copy.
  text: { text: string; pasteMode: PasteMode; snippetId?: string };
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
      // `||` not `??`: an empty target or one ending in a separator yields an
      // empty-string basename, which must fall back to the default name.
      return drafts.launch.target.split(/[/\\]/).pop() || t("sequence.launch");
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
      return assertNever(actionType);
  }
}

/** One-line "what will happen" preview of the drafted action, for the live
 *  summary above the modal footer. Pure, like autoName. */
export function describeAction(
  effectiveCategory: string,
  drafts: PickerDrafts,
  t: TFunction,
  profiles: Profile[],
): string {
  const category = ACTION_CATEGORIES.find((c) => c.id === effectiveCategory) ?? ACTION_CATEGORIES[0];
  switch (category.actionType) {
    case "shortcut": {
      const combo = [...modifierLabels(drafts.shortcut), drafts.shortcut.key || null].filter(Boolean).join(" + ");
      return combo ? t("picker.previewShortcut", { combo }) : t("picker.previewEmpty");
    }
    case "mouseAction": {
      const mods = modifierLabels(drafts.mouse);
      const label = mouseActionLabel(drafts.mouse.action) ?? "";
      const combo = mods.length > 0 ? `${mods.join(" + ")} + ${label}` : label;
      return t("picker.previewMouse", { combo });
    }
    case "textSnippet": {
      const text = drafts.text.text.trim().replace(/\s+/g, " ");
      if (!text) return t("picker.previewEmpty");
      const clipped = text.length > 48 ? `${text.slice(0, 48)}…` : text;
      return t("picker.previewText", { text: clipped });
    }
    case "sequence":
      return t("picker.previewSequence", { count: drafts.sequence.length });
    case "launch": {
      const target = drafts.launch.target.trim();
      return target ? t("picker.previewLaunch", { target }) : t("picker.previewEmpty");
    }
    case "mediaKey":
      return t("picker.previewMedia", { key: mediaKeyLabel(drafts.media) ?? "" });
    case "profileSwitch": {
      const p = profiles.find((pr) => pr.id === drafts.profile);
      return p ? t("picker.previewProfile", { name: p.name }) : t("picker.previewEmpty");
    }
    case "menu":
      return t("picker.previewMenu", { count: drafts.menuItems.length });
    case "disabled":
      return t("picker.previewDisabled");
    case "repairClipboard":
      return t("picker.previewRepair");
    default:
      return assertNever(category.actionType);
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
        // A live snippetId means the button links to a library snippet
        // (source: libraryRef). Editing the text in the picker clears snippetId
        // upstream, detaching into an inline copy — so here snippetId is the
        // single source of truth for link-vs-inline.
        if (drafts.text.snippetId) {
          return {
            id: actionId,
            type: "textSnippet" as const,
            payload: { source: "libraryRef" as const, snippetId: drafts.text.snippetId },
            displayName,
          };
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
        return assertNever(actionType);
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
  throttleMs: number;
}

/** Seed the text draft: a libraryRef action resolves its snippet so the textarea
 *  previews the linked text and `snippetId` marks it as linked; an inline action
 *  seeds its own text; anything else starts empty. */
function seedTextDraft(
  existingAction: Action | null,
  snippetLibrary: SnippetLibraryItem[],
): PickerDrafts["text"] {
  if (existingAction?.type === "textSnippet") {
    const payload = existingAction.payload;
    if (payload.source === "inline") {
      return { text: payload.text, pasteMode: payload.pasteMode };
    }
    const snippet = snippetLibrary.find((s) => s.id === payload.snippetId);
    return {
      text: snippet?.text ?? "",
      pasteMode: snippet?.pasteMode ?? "sendText",
      snippetId: payload.snippetId,
    };
  }
  return { text: "", pasteMode: "sendText" };
}

/** Seed every picker draft from the action being edited (or sensible defaults
 *  for a new action). Pure: no React, no storage — just data in, data out. */
export function createInitialDrafts(
  existingAction: Action | null,
  binding: Binding | null,
  profiles: Profile[],
  snippetLibrary: SnippetLibraryItem[] = [],
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
    text: seedTextDraft(existingAction, snippetLibrary),
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
    throttleMs: binding?.throttleMs ?? 0,
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
  // A library-linked snippet (snippetId set) is always saveable even if the
  // resolved preview text is momentarily empty; an inline snippet needs content.
  if (effectiveCategory === "textSnippet") return !drafts.text.snippetId && !drafts.text.text.trim();
  if (effectiveCategory === "launch") return !drafts.launch.target.trim();
  // Audit F005: an empty menu passes the backend schema check only to be rejected by
  // validate_action (menu must have >=1 item), which rolls back the whole draft. Block
  // Save here so the user keeps their work instead of losing it to a backend error.
  if (effectiveCategory === "menu") return drafts.menuItems.length === 0;
  return false;
}
