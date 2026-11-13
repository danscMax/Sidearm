import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../../../i18n";

import { CaptureRow } from "./CaptureRow";
import { setKeyRecording } from "../../../lib/backend";

vi.mock("../../../lib/backend", () => ({ setKeyRecording: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => { vi.mocked(setKeyRecording).mockReset().mockResolvedValue(undefined); });
afterEach(async () => { cleanup(); await act(async () => {}); });

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

  it("keeps recording mode enabled until the last capture row releases it", async () => {
    const row = (key: string) => <CaptureRow key={key} value="" placeholder="" ariaLabel={key} capturing onToggle={vi.fn()} />;
    const { rerender, unmount } = render(<>{row("one")}{row("two")}</>);
    await act(async () => {});
    rerender(<>{row("two")}</>);
    await act(async () => {});
    expect(setKeyRecording).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(setKeyRecording).mock.calls.some(([on]) => !on)).toBe(false);
    unmount();
    await act(async () => {});
    expect(setKeyRecording).toHaveBeenLastCalledWith(false);
  });
});
