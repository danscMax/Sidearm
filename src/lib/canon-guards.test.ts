import { describe, it, expect } from "vitest";

// Adoption ratchets. This stack has no source-level linter (ESLint/stylelint are
// deliberately absent), so bypassing a shared primitive compiles green. These
// cheap source greps are the guard the canon audit recommended: a new raw
// `<select>` / `notice` banner / inline style / un-wrapped IPC listen fails CI
// instead of quietly drifting. Whitelists are the justified exceptions the audit
// documented (a primitive that genuinely does not fit that one site).

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

describe("canon adoption guards", () => {
  it("scans the source tree", () => {
    expect(ENTRIES.length).toBeGreaterThan(50);
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
});
