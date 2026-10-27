import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DpiStagesEditor } from "./DpiStagesEditor";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

const props = {
  stages: [400, 800, 1600],
  startingDpi: 800,
  currentDpi: undefined,
  dpiMin: 100,
  dpiMax: 30000,
  busy: false,
};

describe("profile DPI editor", () => {
  it("changes the starting stage without mutating other stages", () => {
    const onSave = vi.fn();
    render(<DpiStagesEditor {...props} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Set starting DPI to 1600/i }));
    expect(onSave).toHaveBeenCalledWith([400, 800, 1600], 1600);
  });

  it("updates a selected stage with Enter and rejects duplicates", () => {
    const onSave = vi.fn();
    render(<DpiStagesEditor {...props} onSave={onSave} />);
    const input = screen.getByRole("spinbutton", { name: /Edit selected stage/i });
    fireEvent.change(input, { target: { value: "900" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith([400, 900, 1600], 900);
    fireEvent.change(input, { target: { value: "1600" } });
    expect(screen.getByRole("button", { name: /Update stage/i }).hasAttribute("disabled")).toBe(true);
  });

  it("double-clicks a stage for direct editing", () => {
    const onSave = vi.fn();
    render(<DpiStagesEditor {...props} onSave={onSave} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /Set starting DPI to 800/i }));
    const input = screen.getByRole("spinbutton", { name: /Edit 800 DPI stage/i });
    fireEvent.change(input, { target: { value: "950" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith([400, 950, 1600], 950);
  });
});
