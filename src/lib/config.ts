export type Layer = "standard" | "hypershift";

export type ControlFamily = "thumbGrid" | "topPanel" | "wheel" | "system";

export type CapabilityStatus =
  | "verified"
  | "needsValidation"
  | "reserved"
  | "partiallyRemappable";

export type ControlId =
  | "thumb_01"
  | "thumb_02"
  | "thumb_03"
  | "thumb_04"
  | "thumb_05"
  | "thumb_06"
  | "thumb_07"
  | "thumb_08"
  | "thumb_09"
  | "thumb_10"
  | "thumb_11"
  | "thumb_12"
  | "mouse_left"
  | "mouse_right"
  | "top_aux_01"
  | "top_aux_02"
  | "mouse_4"
  | "mouse_5"
  | "wheel_up"
  | "wheel_down"
  | "wheel_click"
  | "wheel_left"
  | "wheel_right"
  | "hypershift_button"
  | "top_special_01"
  | "top_special_02"
  | "top_special_03";

export type MappingSource = "synapse" | "reserved" | "detected";

export type ActionType =
  | "shortcut"
  | "textSnippet"
  | "sequence"
  | "launch"
  | "menu"
  | "disabled";

export type PasteMode = "clipboardPaste" | "sendText";

export type ValidationSeverity = "warning";

export interface ValidationWarning {
  code: string;
  message: string;
  path?: string;
  severity: ValidationSeverity;
}

export interface Settings {
  fallbackProfileId: string;
  theme: string;
  startWithWindows: boolean;
  minimizeToTray: boolean;
  debugLogging: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
}

export interface PhysicalControl {
  id: ControlId;
  family: ControlFamily;
  defaultName: string;
  synapseName?: string;
  remappable: boolean;
  capabilityStatus: CapabilityStatus;
  notes?: string;
}

export interface EncoderMapping {
  controlId: ControlId;
  layer: Layer;
  encodedKey: string;
  source: MappingSource;
  verified: boolean;
}

export interface AppMapping {
  id: string;
  exe: string;
  titleIncludes?: string[];
  profileId: string;
  enabled: boolean;
  priority: number;
}

export interface Binding {
  id: string;
  profileId: string;
  layer: Layer;
  controlId: ControlId;
  label: string;
  actionRef: string;
  colorTag?: string;
  enabled: boolean;
}

export interface ShortcutActionPayload {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  win: boolean;
  raw?: string;
}

export type TextSnippetPayload =
  | {
      source: "inline";
      text: string;
      pasteMode: PasteMode;
      tags: string[];
    }
  | {
      source: "libraryRef";
      snippetId: string;
    };

export type SequenceStep =
  | { type: "send"; value: string; delayMs?: number }
  | { type: "text"; value: string; delayMs?: number }
  | { type: "sleep"; delayMs: number }
  | {
      type: "launch";
      value: string;
      args?: string[];
      workingDir?: string;
      delayMs?: number;
    };

export interface SequenceActionPayload {
  steps: SequenceStep[];
}

export interface LaunchActionPayload {
  target: string;
  args?: string[];
  workingDir?: string;
}

export type MenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      actionRef: string;
      enabled: boolean;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      items: MenuItem[];
      enabled: boolean;
    };

export interface MenuActionPayload {
  items: MenuItem[];
}

export type DisabledActionPayload = Record<string, never>;

export type ActionPayload =
  | ShortcutActionPayload
  | TextSnippetPayload
  | SequenceActionPayload
  | LaunchActionPayload
  | MenuActionPayload
  | DisabledActionPayload;

export interface Action {
  id: string;
  type: ActionType;
  payload: ActionPayload;
  pretty: string;
  notes?: string;
}

export interface SnippetLibraryItem {
  id: string;
  name: string;
  text: string;
  pasteMode: PasteMode;
  tags: string[];
  notes?: string;
}

export interface AppConfig {
  version: number;
  settings: Settings;
  profiles: Profile[];
  physicalControls: PhysicalControl[];
  encoderMappings: EncoderMapping[];
  appMappings: AppMapping[];
  bindings: Binding[];
  actions: Action[];
  snippetLibrary: SnippetLibraryItem[];
}

export interface LoadConfigResponse {
  config: AppConfig;
  warnings: ValidationWarning[];
  path: string;
  createdDefault: boolean;
}

export interface SaveConfigResponse {
  config: AppConfig;
  warnings: ValidationWarning[];
  path: string;
  backupPath?: string;
}

export interface CommandError {
  code: string;
  message: string;
  details?: string[];
}
