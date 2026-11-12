import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../../../i18n";

import { CaptureRow } from "./CaptureRow";

afterEach(() => cleanup());

describe("CaptureRow", () => {
  it("with captureOnFocus, a click into the field starts the capture once and leaving it stops it", () => {
    const onToggle = vi.fn();
    render(<CaptureRow ariaLabel="Key" value="" placeholder="" capturing={false} onToggle={onToggle} captureOnFocus />);
    const input = screen.getByRole("textbox", { name: "Key" });
    fireEvent.focus(input);
    fireEvent.click(input); // the same click: must not toggle it back off
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).toBeNull(); // no Record button
    fireEvent.blur(input);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("without it, keeps the Record button", () => {
    render(<CaptureRow ariaLabel="Signal" value="" placeholder="" capturing={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("button")).toBeTruthy();
  });
});
