import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import en from "../i18n/locales/en.json";
import ru from "../i18n/locales/ru.json";
import { recoveryTestInstruction } from "./labels";
import type { HypershiftTrigger } from "./config";
import { ALL_ACTION_TYPES } from "./constants/ui-copy";

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value !== "object" || !value) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof entry === "string" ? [[path, entry]] : Object.entries(flatten(entry, path));
  }));
}
const plural = /_(zero|one|two|few|many|other)$/;
const locales = { en: flatten(en), ru: flatten(ru) };
const parameters = (text: string) => [...text.matchAll(/{{-?\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
afterEach(async () => { await i18n.changeLanguage("ru"); });

describe("complete locale catalogues", () => {
  it("has the same messages in both languages, allowing their different plural categories", () => {
    const stems = (catalogue: Record<string, string>) => [...new Set(Object.keys(catalogue).map((key) => key.replace(plural, "")))].sort();
    expect(stems(locales.en)).toEqual(stems(locales.ru));
  });

  it("covers every required plural category and preserves interpolation parameters", () => {
    for (const [language, catalogue] of Object.entries(locales)) {
      const groups = new Set(Object.keys(catalogue).filter((key) => plural.test(key)).map((key) => key.replace(plural, "")));
      for (const stem of groups) {
        for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
          expect(catalogue[`${stem}_${category}`], `${language}: ${stem}_${category}`).toBeTypeOf("string");
        }
      }
      for (const [key, text] of Object.entries(catalogue)) {
        const counterpart = locales.en[key] ?? locales.en[key.replace(plural, "_other")];
        expect(counterpart, key).toBeTypeOf("string");
        expect(parameters(text), `${language}: ${key}`).toEqual(parameters(counterpart));
      }
    }
  });
});

describe("every action type is described", () => {
  it("has its picker category description in both languages", () => {
    const missing = ALL_ACTION_TYPES.flatMap((type) =>
      (["en", "ru"] as const).filter((lang) => !locales[lang][`picker.categoryDesc.${type}`]).map((lang) => `${lang}:${type}`));
    expect(missing).toEqual([]);
  });
});

describe("natural counts", () => {
  it("declines counts instead of writing (s) or cutting a word short", () => {
    const englishS = Object.entries(locales.en).filter(([, text]) => /\w\(s\)/.test(text));
    // "шаг.)", "пункт.)": a word cut short before a count's closing bracket
    // (standard abbreviations such as "симв." stay allowed).
    const standard = new Set(["симв"]);
    const russianCut = Object.entries(locales.ru).filter(([, text]) =>
      [...text.matchAll(/([а-яё]{3,})\.\)/gi)].some((match) => !standard.has(match[1].toLowerCase())));
    expect(englishS).toEqual([]);
    expect(russianCut).toEqual([]);
  });
});

describe("configuration-aware recovery instructions", () => {
  it("does not ask for HyperShift when it is off", () => {
    expect(recoveryTestInstruction("none")).not.toMatch(/HyperShift|ПКМ|ЛКМ/);
  });
  it.each<[HypershiftTrigger, string]>([
    ["mouse_right", "ПКМ"], ["wheel_click", "Клик колесом"],
    ["mouse_4", "Назад"], ["mouse_5", "Вперёд"],
  ])("names the selected trigger %s", (trigger, name) => {
    expect(recoveryTestInstruction(trigger)).toContain(`удерживайте ${name}`);
  });
  it("does not ask a left-button trigger to click itself", () => {
    const instruction = recoveryTestInstruction("mouse_left");
    expect(instruction).toContain("удерживайте ЛКМ");
    expect(instruction).not.toContain("нажмите ЛКМ");
    expect(instruction).not.toContain("контекстное меню");
  });
  it("localizes the physical trigger and defaults consistently with the backend", async () => {
    expect(recoveryTestInstruction()).toContain("удерживайте ПКМ");
    await i18n.changeLanguage("en");
    expect(recoveryTestInstruction("wheel_click")).toContain("hold Wheel click");
    expect(recoveryTestInstruction("none")).not.toContain("HyperShift");
  });
});
