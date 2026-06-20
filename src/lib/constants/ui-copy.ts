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

/** All action-type discriminators, derived from the SoT label map so a new
 *  `ActionType` (which must be added to `ACTION_TYPE_LABELS` — a compile-guarded
 *  `Record`) automatically appears in every list below. The FE mirror of the
 *  Rust `ActionType::ALL` guarded by `action_type_set_matches_schema_enum`. */
export const ALL_ACTION_TYPES = Object.keys(ACTION_TYPE_LABELS) as ActionType[];

/** Per-type picker glyph. A `Record` so a new `ActionType` fails to compile
 *  until it is given an icon, exactly like `ACTION_TYPE_LABELS`. Local to this
 *  file (only `ACTION_CATEGORIES` reads it) so it isn't a dangling export. */
const ACTION_TYPE_ICONS: Record<ActionType, string> = {
  shortcut: "KB",
  mouseAction: "MS",
  textSnippet: "Tx",
  sequence: "Sq",
  launch: "Ex",
  mediaKey: "Md",
  profileSwitch: "Pf",
  menu: "Mn",
  disabled: "—",
  repairClipboard: "Rb",
};

/** Derived from `ALL_ACTION_TYPES` — structurally cannot drift from the type set. */
export const editableActionTypes: Array<{ value: ActionType; label: string }> =
  ALL_ACTION_TYPES.map((value) => ({ value, label: ACTION_TYPE_LABELS[value] }));

/** Derived from `ALL_ACTION_TYPES` — structurally cannot drift from the type set. */
export const ACTION_CATEGORIES: ActionCategory[] = ALL_ACTION_TYPES.map((actionType) => ({
  id: actionType,
  icon: ACTION_TYPE_ICONS[actionType],
  label: ACTION_TYPE_LABELS[actionType],
  actionType,
}));

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
