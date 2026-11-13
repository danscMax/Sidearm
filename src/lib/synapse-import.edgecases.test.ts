import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { describeParsedAction, type ParsedMacro } from "./synapse-import";

describe("describeParsedAction edge cases", () => {
  it.each(["", "long text".repeat(1000)])("describes a text snippet without exposing its contents", (text) => {
    expect(describeParsedAction({ kind: "textSnippet", text }, [])).toBe(i18n.t("action.type.textSnippet"));
  });

  it("describes disabled actions", () => {
    expect(describeParsedAction({ kind: "disabled" }, [])).toBe(i18n.t("action.type.disabled"));
  });

  it("translates known mouse actions and keeps an unknown action readable", () => {
    expect(describeParsedAction({ kind: "mouseAction", action: "leftClick" }, []))
      .toBe(i18n.t("actionSummary.mouse", { value: i18n.t("mouseAction.leftClick") }));
    expect(describeParsedAction({ kind: "mouseAction", action: "futureMouseAction" }, []))
      .toBe(i18n.t("actionSummary.mouse", { value: "futureMouseAction" }));
  });

  it("handles absent shortcut modifiers", () => {
    expect(describeParsedAction({ kind: "shortcut", key: "F13" }, []))
      .toBe(i18n.t("actionSummary.shortcut", { value: "F13" }));
  });

  it("counts steps of the matching macro rather than the first macro", () => {
    const macros: ParsedMacro[] = [
      { synapseGuid: "other", name: "Other", steps: [{ kind: "send", value: "C" }] },
      { synapseGuid: "chosen", name: "Chosen", steps: [{ kind: "send", value: "V" }, { kind: "sleep", delayMs: 50 }] },
    ];
    expect(describeParsedAction({ kind: "sequence", macroGuid: "chosen" }, macros))
      .toBe(i18n.t("actionSummary.sequence", { count: 2 }));
  });
});
