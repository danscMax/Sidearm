// Checks of the config shown beside the buttons: broken references a hand or
// script edit can leave (an assignment or a menu item pointing at an action
// that is gone, a phrase pointing at a deleted library text), and risky pairs
// on one button — a press that sends Enter next to one that closes the window —
// and the same text, macro, menu or launch on several buttons of one mouse and
// layer (a duplicate is often a leftover; same shortcuts are the conflict banner's).

import type { Action, AppConfig, Binding, MenuItem } from "./config";

export type ConfigIssue =
  | { kind: "missingAction"; where: string }
  | { kind: "missingSnippet"; where: string }
  | { kind: "enterNextToClose"; binding: Binding }
  | { kind: "duplicate"; name: string; bindings: Binding[] };

const CLOSE_SHORTCUTS = new Set(["alt+f4", "ctrl+w", "ctrl+shift+w", "ctrl+f4"]);

function shortcutText(action: Action): string | null {
  if (action.type !== "shortcut") return null;
  const p = action.payload;
  return [p.ctrl && "ctrl", p.shift && "shift", p.alt && "alt", p.win && "win", p.key.toLowerCase()].filter(Boolean).join("+");
}

function closesWindow(action: Action | undefined): boolean {
  const keys = action ? shortcutText(action) : null;
  return keys != null && CLOSE_SHORTCUTS.has(keys);
}

function sendsEnter(action: Action | undefined): boolean {
  if (!action) return false;
  if (action.type === "shortcut") return shortcutText(action) === "enter";
  if (action.type === "sequence") return action.payload.steps.some((step) => step.type === "send" && step.value.toLowerCase() === "enter");
  return false;
}

/** What a button does, as a key for spotting the same thing on two buttons;
 *  null for shortcuts and clicks (the conflict banner and plain use). */
function contentKey(action: Action, library: Map<string, string>): string | null {
  switch (action.type) {
    case "textSnippet":
      return `text:${action.payload.source === "inline" ? action.payload.text : library.get(action.payload.snippetId) ?? action.payload.snippetId}`;
    case "sequence":
      return `sequence:${JSON.stringify(action.payload.steps)}`;
    case "menu":
      return `menu:${action.id}`;
    case "launch":
      return `launch:${action.payload.target}\u0000${(action.payload.args ?? []).join(" ")}`;
    default:
      return null;
  }
}

/** The issues of one profile (its assignments, and the menus they open). */
export function checkProfile(config: AppConfig, profileId: string): ConfigIssue[] {
  const actions = new Map(config.actions.map((action) => [action.id, action]));
  const snippets = new Set(config.snippetLibrary.map((snippet) => snippet.id));
  const issues: ConfigIssue[] = [];
  const bindings = config.bindings.filter((binding) => binding.profileId === profileId && binding.enabled);

  const checkAction = (action: Action, where: string, seen: Set<string>) => {
    if (seen.has(action.id)) return;
    seen.add(action.id);
    if (action.type === "textSnippet" && action.payload.source === "libraryRef" && !snippets.has(action.payload.snippetId)) {
      issues.push({ kind: "missingSnippet", where });
    }
    if (action.type === "menu") {
      const walk = (items: MenuItem[], path: string) => items.forEach((item) => {
        const here = `${path} › ${item.label}`;
        if (item.kind === "submenu") return walk(item.items, here);
        const inner = actions.get(item.actionId);
        if (!inner) issues.push({ kind: "missingAction", where: here });
        else checkAction(inner, here, seen);
      });
      walk(action.payload.items, action.displayName);
    }
  };

  const seen = new Set<string>();
  for (const binding of bindings) {
    const action = actions.get(binding.actionId);
    if (!action) issues.push({ kind: "missingAction", where: binding.label || binding.controlId });
    else checkAction(action, binding.label || action.displayName, seen);
  }

  // One button and layer: a gesture that sends Enter and another that closes the window.
  const slots = new Map<string, Binding[]>();
  for (const binding of bindings) {
    const key = `${binding.layer}\u0000${binding.controlId}`;
    slots.set(key, [...(slots.get(key) ?? []), binding]);
  }
  for (const group of slots.values()) {
    if (group.length < 2) continue;
    const enter = group.some((binding) => sendsEnter(actions.get(binding.actionId)));
    const close = group.find((binding) => closesWindow(actions.get(binding.actionId)));
    if (enter && close) issues.push({ kind: "enterNextToClose", binding: close });
  }

  // The same thing on two buttons of one mouse and layer.
  const library = new Map(config.snippetLibrary.map((snippet) => [snippet.id, snippet.text]));
  const deviceOf = new Map(config.physicalControls.map((control) => [control.id, control.deviceId]));
  const same = new Map<string, { name: string; bindings: Binding[] }>();
  for (const binding of bindings) {
    const action = actions.get(binding.actionId);
    const content = action ? contentKey(action, library) : null;
    if (!action || !content) continue;
    const key = `${deviceOf.get(binding.controlId)}\u0000${binding.layer}\u0000${content}`;
    const group = same.get(key) ?? { name: action.displayName, bindings: [] };
    group.bindings.push(binding);
    same.set(key, group);
  }
  for (const group of same.values()) {
    if (new Set(group.bindings.map((binding) => binding.controlId)).size > 1) issues.push({ kind: "duplicate", ...group });
  }
  return issues;
}
