import { describe, it, expect } from "vitest";
import * as ts from "typescript";

// Adoption ratchets. This stack has no source-level linter (ESLint/stylelint are
// deliberately absent), so bypassing a shared primitive compiles green. These
// Local source checks catch a raw form field, duplicate primitive, inline style
// or unwrapped IPC listener before it quietly drifts. JSX checks use the existing
// compiler to understand inherited wrappers and deferred config callbacks.
// Exceptions identify an intentionally specialized composite control.

// Vite-native raw import of every source file as a string — no Node fs needed.
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Glob keys are relative to this file (src/lib): same-dir files come through as
// `./x.ts`, the rest as `../dir/x.tsx`. Normalise both to a src-relative path.
function toSrcRel(key: string): string {
  if (key.startsWith("../")) return key.slice(3);
  if (key.startsWith("./")) return `lib/${key.slice(2)}`;
  return key;
}

const ENTRIES = Object.entries(sources)
  .map(([path, content]) => [toSrcRel(path), content] as const)
  .filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts"));

const TSX = ENTRIES.filter(([path]) => path.endsWith(".tsx"));

// Stylesheets, for the design-token fallback guard below.
const cssSources = import.meta.glob("../**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const CSS = Object.entries(cssSources).map(
  ([path, content]) => [toSrcRel(path), content] as const,
);

const inputClasses = new Set([
  "input", "settings-text-input", "debug-testing__input", "profiles__priority-input",
  "action-picker__search", "profiles-workspace__search",
]);
// These editors deliberately draw a larger composite control around their input.
const specialInputs: Record<string, ReadonlySet<string>> = {
  "components/ChipEditor.tsx": new Set(["chip-editor__input", "chip-editor__chip-edit"]),
  "components/CommandPalette.tsx": new Set(["command-palette__input"]),
  "components/action-picker/TextSnippetEditor.tsx": new Set(["token-textarea__input"]),
};
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(node: Opening, name: string) {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText() === name)?.initializer;
}

function classTokens(node: Opening): string[] {
  const value = attribute(node, "className");
  if (!value) return [];
  if (ts.isStringLiteral(value)) return value.text.split(/\s+/);
  if (ts.isJsxExpression(value) && value.expression) {
    const expression = value.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text.split(/\s+/);
    if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)].join(" ").split(/\s+/);
  }
  return [];
}

function unstyledControls(path: string, content: string): string[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ["input", "textarea", "select"].includes(node.tagName.getText(source))) {
      const type = attribute(node, "type");
      const separateControl = type && ts.isStringLiteral(type) && ["checkbox", "radio", "hidden"].includes(type.text);
      const classes = classTokens(node);
      let styled = classes.some((name) => inputClasses.has(name) || specialInputs[path]?.has(name));
      for (let parent = node.parent; parent && !styled; parent = parent.parent) {
        if (ts.isJsxElement(parent) && parent.openingElement !== node) {
          styled = classTokens(parent.openingElement).some((name) => name === "field" || name === "capture-row");
        }
      }
      if (!separateControl && !styled) offenders.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return offenders;
}

function deferredEventReads(path: string, content: string): string[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  function readsFormEvent(node: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(node) && ["value", "checked"].includes(node.name.text)
      && ts.isPropertyAccessExpression(node.expression) && ["target", "currentTarget"].includes(node.expression.name.text)
      && ts.isIdentifier(node.expression.expression) && ["event", "e"].includes(node.expression.expression.text)) return true;
    return ts.forEachChild(node, readsFormEvent) ?? false;
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && /(?:^|\.)(?:updateDraft|setDraft|setConfig|setActiveConfig)$/.test(node.expression.getText(source))) {
      for (const arg of node.arguments) {
        if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && readsFormEvent(arg)) {
          offenders.push(`${path}:${source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return offenders;
}

describe("canon adoption guards", () => {
  it("scans the source tree", () => {
    expect(ENTRIES.length).toBeGreaterThan(50);
  });

  it("ordinary form controls opt into the canonical input recipe", () => {
    expect(TSX.flatMap(([path, content]) => unstyledControls(path, content))).toEqual([]);
  });

  it("detects a bare unit field but accepts canonical wrappers and classes", () => {
    expect(unstyledControls("Example.tsx", '<div className="input-suffix"><input type="number" /></div>')).toHaveLength(1);
    expect(unstyledControls("Example.tsx", '<div className="field__row"><input /></div>')).toHaveLength(1);
    expect(unstyledControls("Example.tsx", '<label className="field"><div className="input-suffix"><input type="number" /></div></label>')).toEqual([]);
    expect(unstyledControls("Example.tsx", '<input className="input" type="number" />')).toEqual([]);
    expect(unstyledControls("Example.tsx", '<input type="checkbox" />')).toEqual([]);
  });

  it("special-editor exceptions apply to a control rather than a whole file", () => {
    expect(unstyledControls("components/ChipEditor.tsx", '<><input className="chip-editor__input" /><input /></>')).toHaveLength(1);
    expect(unstyledControls("Example.tsx", '<input className="chip-editor__input" />')).toHaveLength(1);
  });

  it("config updaters snapshot form values before deferring", () => {
    expect(TSX.flatMap(([path, content]) => deferredEventReads(path, content))).toEqual([]);
  });

  it("detects deferred event reads while accepting an immediate value snapshot", () => {
    expect(deferredEventReads("Example.tsx", 'const onChange = (event) => updateDraft((config) => ({ ...config, name: event.target.value }));')).toHaveLength(1);
    expect(deferredEventReads("Example.tsx", 'const onChange = (e) => updateDraft((config) => ({ ...config, enabled: e.currentTarget.checked }));')).toHaveLength(1);
    expect(deferredEventReads("Example.tsx", 'const onChange = (event) => { const name = event.currentTarget.value; updateDraft((config) => ({ ...config, name })); };')).toEqual([]);
  });

  it("no inline style={{ }} (CSP style-src forbids inline styles)", () => {
    const offenders = TSX.filter(([, c]) => c.includes("style={{")).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("raw <select> only in SelectField or documented exceptions", () => {
    const allowed = new Set([
      "components/shared.tsx", // SelectField itself
      "components/ControlPropertiesPanel.tsx", // labelled status select (separate visible label)
      "components/AppMappingModal.tsx", // select with integrated field__description
      "components/LogPanel.tsx", // toolbar select, no visible label by design
    ]);
    // `<select\s` matches real JSX (always has attributes) but not the literal
    // `<select>` that appears inside doc-comments.
    const offenders = TSX.filter(
      ([p, c]) => /<select\s/.test(c) && !allowed.has(p),
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("raw 'notice notice--' className only in the Notice component", () => {
    const offenders = TSX.filter(
      ([p, c]) => /notice notice--/.test(c) && p !== "components/shared.tsx",
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("@tauri-apps/api/event imported only by the backend IPC home", () => {
    const offenders = ENTRIES.filter(
      ([p, c]) => /@tauri-apps\/api\/event/.test(c) && p !== "lib/backend.ts",
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("no Cyrillic literals outside i18n locales (UI copy lives in locales/*.json)", () => {
    // The locale JSON files are the single source of UI copy; any Cyrillic in a
    // .ts/.tsx source is an un-migrated literal that would break under `en`. Two
    // documented exceptions: a regex char-class that permits Cyrillic in profile
    // names (not copy), and the "Русский" language endonym shown in its own
    // script by the language switcher (stripped here, not whitelisted per-file,
    // so any OTHER stray Cyrillic in that file still fails).
    const endonym = /Русский/g;
    const offenders = ENTRIES.filter(
      ([p, c]) =>
        p !== "lib/profile-transfer.ts" &&
        /[А-Яа-яЁё]/.test(c.replace(endonym, "")),
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("'toggle-switch' className only in the Toggle component", () => {
    const offenders = TSX.filter(
      ([p, c]) => /toggle-switch/.test(c) && p !== "components/shared.tsx",
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("'modal-backdrop' / 'modal-header' / 'modal-footer' classNames only via ModalShell/ModalHeader/ModalFooter", () => {
    const offenders = TSX.filter(
      ([p, c]) =>
        /"modal-backdrop|"modal-header|"modal-footer/.test(c) && p !== "components/shared.tsx",
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("the × close-icon markup only lives in CloseButton (reuse it, don't re-draw it)", () => {
    const offenders = TSX.filter(
      ([p, c]) => c.includes("M1 1l12 12M13 1L1 13") && p !== "components/shared.tsx",
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("no hardcoded hex fallback in CSS var() (use the token, not a stale literal)", () => {
    // `var(--token, #abc)` lets a literal silently diverge from the real token
    // and masks an undefined token. Cascade fallbacks `var(--a, var(--b))` and
    // token definitions (`--x: #abc;`) are fine — only `#hex` fallbacks fail.
    const offenders = CSS.filter(([, c]) =>
      /var\(--[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/.test(c),
    ).map(([p]) => p);
    expect(offenders).toEqual([]);
  });
});
