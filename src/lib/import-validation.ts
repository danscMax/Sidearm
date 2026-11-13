import configSchema from "../../schemas/config.v5.schema.json";
import { MAX_SEQUENCE_STEPS, type Action, type MenuItem, type SnippetLibraryItem } from "./config";

interface Schema {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  if?: Schema;
  then?: Schema;
  required?: string[];
  properties?: Record<string, Schema>;
  propertyNames?: Schema;
  additionalProperties?: boolean | Schema;
  maxProperties?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

const definitions: Record<string, Schema> = configSchema.$defs;
const keywords = new Set([
  "$ref", "type", "const", "enum", "allOf", "anyOf", "oneOf", "if", "then", "required",
  "properties", "propertyNames", "additionalProperties", "maxProperties", "items", "minItems",
  "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "description", "default", "title",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the keywords used by the config definitions, failing closed on schema additions. */
function matches(value: unknown, schema: Schema, depth = 0): boolean {
  // Schema references consume extra frames beyond the JSON's own nesting.
  if (depth > 512 || Object.keys(schema).some((key) => !keywords.has(key))) return false;
  const check = (part: Schema) => matches(value, part, depth + 1);
  if (schema.$ref) {
    const target = definitions[schema.$ref.replace("#/$defs/", "")];
    if (!target || !check(target)) return false;
  }
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.allOf && !schema.allOf.every(check)) return false;
  if (schema.anyOf && !schema.anyOf.some(check)) return false;
  if (schema.oneOf && schema.oneOf.filter(check).length !== 1) return false;
  if (schema.if && check(schema.if) && schema.then && !check(schema.then)) return false;
  if (schema.type) {
    const type = schema.type;
    if (type === "object" ? !isRecord(value) : type === "array" ? !Array.isArray(value)
      : type === "integer" ? !Number.isInteger(value) : typeof value !== type) return false;
  }
  if (typeof value === "number" && (!Number.isFinite(value)
    || (schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if ((schema.minLength !== undefined && length < schema.minLength)
      || (schema.maxLength !== undefined && length > schema.maxLength)
      || (schema.pattern && !new RegExp(schema.pattern, "u").test(value))) return false;
  }
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems)
      || (schema.maxItems !== undefined && value.length > schema.maxItems)
      || (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
      || (schema.items && !value.every((item) => matches(item, schema.items!, depth + 1)))) return false;
  }
  if (isRecord(value)) {
    if (schema.required?.some((key) => value[key] === undefined)) return false;
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) return false;
    for (const [key, entry] of entries) {
      if (schema.propertyNames && !matches(key, schema.propertyNames, depth + 1)) return false;
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      if (property ? !matches(entry, property, depth + 1) : schema.additionalProperties === false) return false;
      if (!property && isRecord(schema.additionalProperties) && !matches(entry, schema.additionalProperties, depth + 1)) return false;
    }
  }
  return true;
}

export function validConfigPart(name: string, value: unknown): boolean {
  return Object.hasOwn(definitions, name) && matches(value, definitions[name]);
}

export function uniqueIds(entries: { id: string }[]): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length;
}

/** Action/text references resolve inside the export; profile links use the destination after remapping. */
export function validActionReferences(actions: Action[], snippets: SnippetLibraryItem[], profileIds?: ReadonlySet<string>): boolean {
  const ids = new Set(actions.map((action) => action.id));
  const snippetIds = new Set(snippets.map((snippet) => snippet.id));
  const menuRefs = (items: MenuItem[], ownId: string): boolean => uniqueIds(items) && items.every((item) => item.kind === "submenu"
    ? menuRefs(item.items, ownId) : typeof item.actionId === "string" && item.actionId !== ownId && ids.has(item.actionId));
  return actions.every((action) => {
    if (typeof action.displayName !== "string") return false;
    if (action.type === "menu") return menuRefs(action.payload.items, action.id);
    if (action.type === "textSnippet") return action.payload.source === "libraryRef"
      ? snippetIds.has(action.payload.snippetId) : !!action.payload.text.trim();
    if (action.type === "shortcut") return !!action.payload.key.trim() || action.payload.ctrl || action.payload.shift || action.payload.alt || action.payload.win;
    if (action.type === "launch") return !!action.payload.target.trim();
    if (action.type === "profileSwitch") return !!action.payload.targetProfileId.trim()
      && (!profileIds || profileIds.has(action.payload.targetProfileId));
    if (action.type === "sequence") return action.payload.steps.length <= MAX_SEQUENCE_STEPS && action.payload.steps.every((step) =>
      step.delayMs === undefined || step.delayMs <= 0xFFFFFFFF);
    return true;
  });
}
