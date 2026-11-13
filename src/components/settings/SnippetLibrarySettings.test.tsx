import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { AppConfig } from "../../lib/config";
import { makeConfig } from "../../lib/test-fixtures";
import { SnippetLibrarySettings } from "./SnippetLibrarySettings";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

function config() {
  return makeConfig({ snippetLibrary: [
    { id: "a", name: "Snippet A", text: "Text A", pasteMode: "sendText", tags: [] },
    { id: "b", name: "Snippet B", text: "Text B", pasteMode: "sendText", tags: [] },
  ] });
}

const callbacks = { setConfirmModal: vi.fn(), showToast: vi.fn() };

function Library({ onUpdate = () => {} }: { onUpdate?: (config: AppConfig) => void }) {
  const [activeConfig, setConfig] = useState(config);
  return <SnippetLibrarySettings {...callbacks} activeConfig={activeConfig} selectedSnippetId="a"
    updateDraft={(updater) => setConfig((current) => {
      const next = updater(current);
      onUpdate(next);
      return next;
    })} />;
}

describe("snippet library editing", () => {
  it.each(["", " \n\t"])("keeps blank text %j local until valid text can autosave", (blank) => {
    const updates: AppConfig[] = [];
    render(<Library onUpdate={(next) => updates.push(next)} />);
    const text = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") });
    fireEvent.change(text, { target: { value: blank } });
    expect(text.value).toBe(blank);
    expect(updates).toHaveLength(0);
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("snippetLibrary.textRequired"));

    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("snippet.name") }), { target: { value: "Renamed A" } });
    expect(text.value).toBe(blank);
    expect(updates.at(-1)?.snippetLibrary[0]).toMatchObject({ name: "Renamed A", text: "Text A" });

    fireEvent.change(text, { target: { value: "  Replacement text\n" } });
    expect(updates.at(-1)?.snippetLibrary[0].text).toBe("  Replacement text\n");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("keeps the chosen snippet after editing a deep-linked library", () => {
    const updates: AppConfig[] = [];
    render(<Library onUpdate={(next) => updates.push(next)} />);
    fireEvent.click(screen.getByRole("button", { name: /Snippet B/ }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("snippet.text") }), { target: { value: "Changed B" } });
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("Changed B");
    expect(screen.getByRole("button", { name: /Snippet BChanged B/ }).getAttribute("aria-pressed")).toBe("true");
    expect(updates.at(-1)?.snippetLibrary[1].text).toBe("Changed B");
  });

  it("replaces a blank local draft after external text changes or a selection change", () => {
    const original = config();
    const props = { ...callbacks, activeConfig: original, updateDraft: vi.fn() };
    const { rerender } = render(<SnippetLibrarySettings {...props} selectedSnippetId="a" />);
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("snippet.text") }), { target: { value: "" } });
    rerender(<SnippetLibrarySettings {...props} activeConfig={{ ...original, snippetLibrary: original.snippetLibrary.map((snippet) =>
      snippet.id === "a" ? { ...snippet, text: "External text" } : snippet) }} selectedSnippetId="a" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("External text");
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("snippet.text") }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Snippet B/ }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("Text B");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("consumes a deep link once per nonce after its snippet becomes available", () => {
    const props = { ...callbacks, activeConfig: config(), updateDraft: vi.fn(), selectedSnippetId: "a", selectedSnippetNonce: 1 };
    const { rerender } = render(<SnippetLibrarySettings {...props} activeConfig={makeConfig()} />);
    rerender(<SnippetLibrarySettings {...props} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("Text A");
    fireEvent.click(screen.getByRole("button", { name: /Snippet B/ }));
    rerender(<SnippetLibrarySettings {...props} activeConfig={config()} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("Text B");
    rerender(<SnippetLibrarySettings {...props} selectedSnippetNonce={2} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("snippet.text") }).value).toBe("Text A");
  });
});
