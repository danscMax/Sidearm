import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SnippetLibraryItem } from "../../lib/config";
import i18n from "../../i18n";
import { SnippetLibraryPicker } from "./SnippetLibraryPicker";

afterEach(cleanup);

const item = (id: string, name: string, text: string, extra: Partial<SnippetLibraryItem> = {}): SnippetLibraryItem =>
  ({ id, name, text, tags: [], pasteMode: "sendText", ...extra });
const library = [
  item("sig", "Подпись", "\n  С уважением,\nМаксим", { tags: ["почта"] }),
  item("ssh", "SSH login", "ssh admin@server", { pasteMode: "keyboardOnly" }),
  item("hi", "Привет", "Привет!"),
];

function show(linkedId?: string, items = library) {
  const onPick = vi.fn<(snippet: SnippetLibraryItem) => void>();
  render(<SnippetLibraryPicker library={items} uses={new Map([["sig", 3]])} linkedId={linkedId} onPick={onPick} />);
  fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t(linkedId ? "snippet.pickOther" : "snippet.insertFromLibrary")) }));
  return { onPick, search: () => screen.getByRole("combobox", { name: i18n.t("snippet.pickerSearch") }) };
}
const options = () => screen.queryAllByRole("option");

describe("library picker", () => {
  it("lists each text with its first line, badges and uses, and focuses the search", () => {
    const { search } = show();
    expect(document.activeElement).toBe(search());
    expect(options()).toHaveLength(3);
    const sig = options().find((option) => option.textContent?.includes("Подпись"))!;
    expect(sig.textContent).toContain("С уважением,");
    expect(sig.textContent).not.toContain("Максим");
    expect(sig.textContent).toContain("почта");
    expect(sig.textContent).toContain(i18n.t("snippet.placesShort", { count: 3 }));
    const ssh = options().find((option) => option.textContent?.includes("SSH"))!;
    expect(ssh.textContent).toContain(i18n.t("snippet.badgeTyped"));
    expect(ssh.textContent).toContain(i18n.t("snippet.unusedShort"));
  });

  it("filters by name, text and tag, on either layout, and says when nothing matches", () => {
    const { search } = show();
    fireEvent.change(search(), { target: { value: "почта" } });
    expect(options().map((option) => option.querySelector(".lib-picker__name")?.textContent)).toEqual(["Подпись"]);
    fireEvent.change(search(), { target: { value: "ыыр" } });
    expect(options().map((option) => option.querySelector(".lib-picker__name")?.textContent)).toEqual(["SSH login"]);
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(options()).toHaveLength(0);
    expect(screen.getByText(i18n.t("snippet.pickerNoResults", { query: "zzz" }))).toBeTruthy();
  });

  it("moves with the arrows and picks with Enter", () => {
    const { onPick, search } = show();
    const names = options().map((option) => option.querySelector(".lib-picker__name")?.textContent);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(search().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0]![0].name).toBe(names[1]);
    expect(options()).toHaveLength(0);
  });

  it("opens on the linked text and closes on Escape without picking", () => {
    const { onPick } = show("hi");
    const active = options().find((option) => option.getAttribute("aria-selected") === "true")!;
    expect(active.textContent).toContain("Привет");
    expect(active.textContent).toContain(i18n.t("snippet.pickerLinked"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(options()).toHaveLength(0);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks with a click and shows an empty library", () => {
    const { onPick } = show();
    fireEvent.click(options().find((option) => option.textContent?.includes("SSH"))!);
    expect(onPick.mock.calls[0]![0].id).toBe("ssh");
    cleanup();
    show(undefined, []);
    expect(screen.getByText(i18n.t("snippet.pickerEmpty"))).toBeTruthy();
  });
});
