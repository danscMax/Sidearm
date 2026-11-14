import type { AppConfig } from "./config";
import i18n from "../i18n";
import { modifierLabels, mouseActionLabel } from "./action-helpers";

type SourceKind = "synapseV4";

export interface ParsedSynapseProfiles {
  sourceKind: SourceKind;
  sourcePath: string;
  profiles: ParsedProfile[];
  warnings: ImportWarning[];
}

interface ParsedProfile {
  synapseGuid: string;
  name: string;
  bindings: ParsedBinding[];
  macros: ParsedMacro[];
}

interface ParsedBinding {
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

type ParsedSequenceStep =
  | { kind: "send"; value: string }
  | { kind: "sleep"; delayMs: number };

/** What an imported binding will do, in the `actionSummary.*` wording the
 *  rest of the UI uses; a sequence counts the steps of its macro. */
export function describeParsedAction(action: ParsedAction, macros: ParsedMacro[]): string {
  switch (action.kind) {
    case "shortcut":
      return i18n.t("actionSummary.shortcut", {
        value: [...modifierLabels(action), action.key].filter(Boolean).join(" + "),
      });
    case "mouseAction":
      return i18n.t("actionSummary.mouse", { value: mouseActionLabel(action.action) ?? action.action });
    case "sequence":
      return i18n.t("actionSummary.sequence", {
        count: macros.find((m) => m.synapseGuid === action.macroGuid)?.steps.length ?? 0,
      });
    case "textSnippet":
    case "disabled":
      return i18n.t(`action.type.${action.kind}`);
    case "unmappable":
      return i18n.t("synapseImport.unmappable");
  }
}

export interface ImportWarning {
  code: string;
  message: string;
  context?: string;
}

/** Each distinct message once, in first-seen order, with how often it came. */
export function groupWarnings(warnings: readonly ImportWarning[]): { code: string; message: string; count: number }[] {
  const groups = new Map<string, { code: string; message: string; count: number }>();
  for (const warning of warnings) {
    const group = groups.get(warning.message);
    if (group) group.count += 1;
    else groups.set(warning.message, { code: warning.code, message: warning.message, count: 1 });
  }
  return [...groups.values()];
}

export type MergeStrategy = "append" | "replaceByName";

export interface ImportOptions {
  selectedProfileGuids?: string[];
  mergeStrategy?: MergeStrategy;
  /** The word added to a colliding profile name, in the UI language. */
  nameSuffix?: string;
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
