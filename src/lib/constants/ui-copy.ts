import type {
  ActionType,
  ControlFamily,
  Layer,
  MediaKeyKind,
  MouseActionKind,
} from "../config";
import type { VerificationSessionScope } from "../verification-session";
import type { ActionCategory, WorkspaceMode } from "./types";

// NOTE on i18n: these constants intentionally do NOT store rendered display
// text. Any `label`/`body` field below holds an i18n KEY (e.g.
// `action.type.shortcut`), never a translated literal. Consumers resolve the
// real text at render time via `t(key)` (components) or `i18n.t(key)` (plain
// modules), so switching the UI language re-renders correctly. Only structural
// fields (value/actionType/icon/id) are language-neutral. — Audit F004.

export const controlFamilyOrder: ControlFamily[] = ["thumbGrid", "topPanel", "system"];

/** Workspace tab order. Display text (label/heading/body/meta) is resolved by
 *  consumers via `t(\`workspace.${value}.*\`)`, so only `value` lives here. */
export const workspaceModeCopy: Array<{ value: WorkspaceMode }> = [
  { value: "profiles" },
  { value: "debug" },
  { value: "settings" },
];

/** Verification-session scope options. `label`/`body` are i18n KEYS; resolve
 *  with `t(scope.label)` / `t(scope.body)` at render time. */
export const verificationScopeCopy: Array<{
  value: VerificationSessionScope;
  label: string;
  body: string;
}> = [
  {
    value: "currentFamily",
    label: "verificationScope.currentFamily.label",
    body: "verificationScope.currentFamily.body",
  },
  {
    value: "all",
    label: "verificationScope.all.label",
    body: "verificationScope.all.body",
  },
];

/** Layer pills. `label` is an i18n KEY; resolve with `t(layer.label)`. */
export const layerCopy: Array<{ value: Layer; label: string }> = [
  { value: "standard", label: "layer.standard" },
  { value: "hypershift", label: "layer.hypershift" },
];

/** Single source of truth for action-type i18n KEYS. Both `editableActionTypes`
 *  and `ACTION_CATEGORIES` derive their `label` from here so the two lists
 *  cannot drift. Each value is an i18n key — resolve with `t(key)` at render. */
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  shortcut: "action.type.shortcut",
  mouseAction: "action.type.mouseAction",
  textSnippet: "action.type.textSnippet",
  sequence: "action.type.sequence",
  launch: "action.type.launch",
  mediaKey: "action.type.mediaKey",
  profileSwitch: "action.type.profileSwitch",
  menu: "action.type.menu",
  disabled: "action.type.disabled",
  repairClipboard: "action.type.repairClipboard",
};

export const editableActionTypes: Array<{
  value: ActionType;
  label: string;
}> = [
  { value: "shortcut", label: ACTION_TYPE_LABELS.shortcut },
  { value: "mouseAction", label: ACTION_TYPE_LABELS.mouseAction },
  { value: "textSnippet", label: ACTION_TYPE_LABELS.textSnippet },
  { value: "sequence", label: ACTION_TYPE_LABELS.sequence },
  { value: "launch", label: ACTION_TYPE_LABELS.launch },
  { value: "mediaKey", label: ACTION_TYPE_LABELS.mediaKey },
  { value: "profileSwitch", label: ACTION_TYPE_LABELS.profileSwitch },
  { value: "menu", label: ACTION_TYPE_LABELS.menu },
  { value: "disabled", label: ACTION_TYPE_LABELS.disabled },
  { value: "repairClipboard", label: ACTION_TYPE_LABELS.repairClipboard },
];

export const ACTION_CATEGORIES: ActionCategory[] = [
  { id: "shortcut", icon: "KB", label: ACTION_TYPE_LABELS.shortcut, actionType: "shortcut" },
  { id: "mouseAction", icon: "MS", label: ACTION_TYPE_LABELS.mouseAction, actionType: "mouseAction" },
  { id: "textSnippet", icon: "Tx", label: ACTION_TYPE_LABELS.textSnippet, actionType: "textSnippet" },
  { id: "sequence", icon: "Sq", label: ACTION_TYPE_LABELS.sequence, actionType: "sequence" },
  { id: "launch", icon: "Ex", label: ACTION_TYPE_LABELS.launch, actionType: "launch" },
  { id: "mediaKey", icon: "Md", label: ACTION_TYPE_LABELS.mediaKey, actionType: "mediaKey" },
  { id: "profileSwitch", icon: "Pf", label: ACTION_TYPE_LABELS.profileSwitch, actionType: "profileSwitch" },
  { id: "menu", icon: "Mn", label: ACTION_TYPE_LABELS.menu, actionType: "menu" },
  { id: "disabled", icon: "—", label: ACTION_TYPE_LABELS.disabled, actionType: "disabled" },
  { id: "repairClipboard", icon: "Rb", label: ACTION_TYPE_LABELS.repairClipboard, actionType: "repairClipboard" },
];

/** Mouse-action options. `label` is an i18n KEY (`mouseAction.${value}`);
 *  resolve with `t(opt.label)` / `i18n.t(opt.label)` at render time. */
export const MOUSE_ACTION_OPTIONS: Array<{ value: MouseActionKind; label: string }> = [
  { value: "leftClick", label: "mouseAction.leftClick" },
  { value: "rightClick", label: "mouseAction.rightClick" },
  { value: "middleClick", label: "mouseAction.middleClick" },
  { value: "doubleClick", label: "mouseAction.doubleClick" },
  { value: "scrollUp", label: "mouseAction.scrollUp" },
  { value: "scrollDown", label: "mouseAction.scrollDown" },
  { value: "scrollLeft", label: "mouseAction.scrollLeft" },
  { value: "scrollRight", label: "mouseAction.scrollRight" },
  { value: "mouseBack", label: "mouseAction.mouseBack" },
  { value: "mouseForward", label: "mouseAction.mouseForward" },
];

/** Media-key options. `label` is an i18n KEY (`mediaKey.${value}`); resolve
 *  with `t(opt.label)` / `i18n.t(opt.label)` at render time. */
export const MEDIA_KEY_OPTIONS: Array<{ value: MediaKeyKind; label: string }> = [
  { value: "playPause", label: "mediaKey.playPause" },
  { value: "nextTrack", label: "mediaKey.nextTrack" },
  { value: "prevTrack", label: "mediaKey.prevTrack" },
  { value: "stop", label: "mediaKey.stop" },
  { value: "volumeUp", label: "mediaKey.volumeUp" },
  { value: "volumeDown", label: "mediaKey.volumeDown" },
  { value: "mute", label: "mediaKey.mute" },
];
