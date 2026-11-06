import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../../i18n";
import { MouseActionEditor } from "./MouseActionEditor";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("DPI mouse action selection", () => {
  it("clears click modifiers when selecting a hardware DPI step", () => {
    const onChange = vi.fn();
    render(<MouseActionEditor draft={{ action: "leftClick", ctrl: true, shift: true, alt: true, win: true }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "DPI Up" }));
    expect(onChange).toHaveBeenCalledWith({ action: "dpiUp", ctrl: false, shift: false, alt: false, win: false });
  });

  it("finds both DPI actions and hides inapplicable keyboard modifiers", () => {
    render(<MouseActionEditor draft={{ action: "dpiDown", ctrl: false, shift: false, alt: false, win: false }} searchQuery="dpi" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "DPI Up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DPI Down" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Left click" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Ctrl" })).toBeNull();
  });
});
