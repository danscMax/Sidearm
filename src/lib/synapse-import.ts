import type { AppConfig } from "./config";

export type SourceKind = "synapseV4";

export interface ParsedSynapseProfiles {
  sourceKind: SourceKind;
  sourcePath: string;
  profiles: ParsedProfile[];
  warnings: ImportWarning[];
}

export interface ParsedProfile {
  synapseGuid: string;
  name: string;
  bindings: ParsedBinding[];
  macros: ParsedMacro[];
}

export interface ParsedBinding {
  controlId: string;
  layer: "standard" | "hypershift";
  sourceInputId: string;
  label: string;
  action: ParsedAction;
}

export type ParsedAction =
  | {
      kind: "shortcut";
      key: string;
      ctrl?: boolean;
      shift?: boolean;
      alt?: boolean;
      win?: boolean;
    }
  | { kind: "textSnippet"; text: string }
  | { kind: "sequence"; macroGuid: string }
  | { kind: "mouseAction"; action: string }
  | { kind: "disabled" }
  | { kind: "unmappable"; reason: string };

export interface ParsedMacro {
  synapseGuid: string;
  name: string;
  steps: ParsedSequenceStep[];
}

export type ParsedSequenceStep =
  | { kind: "send"; value: string }
  | { kind: "sleep"; delayMs: number };

export interface ImportWarning {
  code: string;
  message: string;
  context?: string;
}

export interface ImportOptions {
  selectedProfileGuids?: string[];
}

export interface ImportSummary {
  profilesAdded: number;
  bindingsAdded: number;
  actionsAdded: number;
  macrosAdded: number;
  skipped: number;
}

export interface ImportedConfig {
  config: AppConfig;
  warnings: ImportWarning[];
  summary: ImportSummary;
}
