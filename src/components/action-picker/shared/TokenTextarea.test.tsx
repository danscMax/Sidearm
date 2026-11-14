import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../../../i18n";
import { TokenTextarea } from "./TokenTextarea";

afterEach(cleanup);

function show(value: string) {
  const onChange = vi.fn<(text: string) => void>();
  const { container } = render(<TokenTextarea value={value} onChange={onChange} ariaLabel="Text" />);
  return { onChange, marks: () => [...container.querySelectorAll("mark")].map((mark) => [mark.textContent, mark.className]) };
}

describe("token textarea", () => {
  it("highlights only real tokens: an escaped {{date}} is typed as is", () => {
    const { marks } = show("{{date}} {date} {clipbord} {a: 1}");
    expect(marks()).toEqual([
      ["{date}", "token-textarea__mark"],
      ["{clipbord}", "token-textarea__mark token-textarea__mark--warn"],
    ]);
  });

  it("previews the phrase with the date filled and the clipboard as a placeholder", () => {
    show("Hi {clipboard} {{x}}");
    const preview = screen.getByText(i18n.t("picker.previewLabel")).parentElement!;
    expect(preview.textContent).toBe(`${i18n.t("picker.previewLabel")}Hi ${i18n.t("picker.previewSlot.clipboard")} {x}`);
    cleanup();
    show("plain text");
    expect(screen.queryByText(i18n.t("picker.previewLabel"))).toBeNull();
  });

  it("warns about a typo and a wrong date letter, each with its fix", () => {
    const { onChange } = show("{clipbord} {date:YYYY-MM-DD}");
    expect(screen.getByText(i18n.t("picker.tokenUnknownLike", { token: "{clipbord}", fix: "{clipboard}" }))).toBeTruthy();
    expect(screen.getByText(i18n.t("picker.tokenDateLetters", { token: "{date:YYYY-MM-DD}" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.tokenFix", { fix: "{date:yyyy-MM-dd}" }) }));
    expect(onChange).toHaveBeenLastCalledWith("{clipbord} {date:yyyy-MM-dd}");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.tokenFix", { fix: "{clipboard}" }) }));
    expect(onChange).toHaveBeenLastCalledWith("{clipboard} {date:YYYY-MM-DD}");
  });

  it("inserts a token chip at the caret", () => {
    const { onChange } = show("ab");
    const box = screen.getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
    box.setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.tokenInsertAria", { token: "{clipboard}" }) }));
    expect(onChange).toHaveBeenLastCalledWith("a{clipboard}b");
  });
});
