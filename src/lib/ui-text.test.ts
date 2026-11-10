import { describe, it, expect } from "vitest";
import en from "../i18n/locales/en.json";
import ru from "../i18n/locales/ru.json";
import i18n from "../i18n";
import { nativeTexts, uiText } from "./ui-text";

// Every `ui_text!("area.name", …)` in the Rust backend.
const rustSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rustKeys(): Set<string> {
  const keys = new Set<string>();
  for (const source of Object.values(rustSources)) {
    for (const match of source.matchAll(/ui_text!\(\s*"([a-zA-Z]+\.[a-zA-Z0-9]+)"/g)) {
      if (!match[1].startsWith("demo.")) keys.add(match[1]); // demo.* = ui_text.rs's own unit test
    }
  }
  return keys;
}

function localeKeys(locale: { backend?: Record<string, Record<string, string>> }): Set<string> {
  return new Set(
    Object.entries(locale.backend ?? {}).flatMap(([area, entries]) => Object.keys(entries).map((name) => `${area}.${name}`)),
  );
}

describe("backend texts", () => {
  it("every Rust ui_text! key is translated in en and ru", () => {
    const keys = rustKeys();
    expect(keys.size).toBeGreaterThan(50);
    const missing = (locale: Set<string>) => [...keys].filter((key) => !locale.has(key));
    expect(missing(localeKeys(en))).toEqual([]);
    expect(missing(localeKeys(ru))).toEqual([]);
  });

  it("en and ru carry the same backend keys and placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();
    expect([...localeKeys(ru)].sort()).toEqual([...localeKeys(en)].sort());
    for (const [area, entries] of Object.entries(en.backend)) {
      for (const [name, text] of Object.entries(entries)) {
        const other = (ru.backend as Record<string, Record<string, string>>)[area][name];
        expect(placeholders(other), `${area}.${name}`).toEqual(placeholders(text));
      }
    }
  });

  it("uiText translates a keyed text and falls back to the English", async () => {
    await i18n.changeLanguage("ru");
    expect(uiText({ text: "x", key: "guard.batteryLow", params: { model: "Razer Naga V3 Pro", percent: "9" } })).toBe("Razer Naga V3 Pro: заряд 9%");
    expect(uiText({ text: "English only", key: "no.suchKey" })).toBe("English only");
    expect(uiText("plain")).toBe("plain");
    expect(nativeTexts()["runtime.osdProfileLabel"]).toBe("Профиль:");
    await i18n.changeLanguage("en");
    expect(nativeTexts()["runtime.osdProfileLabel"]).toBe("Profile:");
  });
});
