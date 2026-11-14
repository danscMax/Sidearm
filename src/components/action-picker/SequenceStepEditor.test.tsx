import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { SequenceStep } from "../../lib/config";

import i18n from "../../i18n";
import { SequenceStepEditor } from "./SequenceStepEditor";
import { CaptureRow } from "./shared/CaptureRow";
import * as backend from "../../lib/backend";

// Keep every real backend export (they invoke Tauri, harmlessly stubbed in
// test-setup) but spy on recorder/capture calls so we can assert the chord
// string the keydown handler forwards.
vi.mock("../../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/backend")>();
  return {
    ...actual,
    recordKeystroke: vi.fn(() => Promise.resolve(1)),
    startMacroRecording: vi.fn(() => Promise.resolve()),
    stopMacroRecording: vi.fn(() => Promise.resolve({ steps: [], startedAt: 0, stoppedAt: 1 })),
    setKeyRecording: vi.fn(() => Promise.resolve()),
  };
});

beforeEach(() => {
  vi.mocked(backend.recordKeystroke).mockReset().mockResolvedValue(1);
  vi.mocked(backend.startMacroRecording).mockReset().mockResolvedValue(undefined);
  vi.mocked(backend.stopMacroRecording).mockReset().mockResolvedValue({ steps: [], startedAt: 0, stoppedAt: 1 });
  vi.mocked(backend.setKeyRecording).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Render the editor and enter recording mode (the window keydown listener is
 *  only attached while recording). */
async function startRecording(onChange = vi.fn()) {
  const view = render(<SequenceStepEditor steps={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
  await screen.findByRole("button", { name: i18n.t("picker.stopRecording") });
  await act(async () => {});
  return { ...view, onChange };
}

describe("SequenceStepEditor macro recorder (F3)", () => {
  it("emits modifiers in canon order Ctrl→Shift→Alt→Win (not the old Ctrl→Alt→Shift)", async () => {
    await startRecording();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
        metaKey: true,
      }),
    );
    await act(async () => {});
    expect(backend.recordKeystroke).toHaveBeenCalledWith(
      expect.stringMatching(/^Ctrl\+Shift\+Alt\+Win\+/),
      undefined,
    );
  });

  it("captures the Win (Meta) modifier that the old recorder dropped", async () => {
    await startRecording();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", metaKey: true }),
    );
    await act(async () => {});
    expect(backend.recordKeystroke).toHaveBeenCalledWith(expect.stringMatching(/^Win\+/), undefined);
  });

  it("ignores bare modifier presses (no chord recorded)", async () => {
    await startRecording();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(backend.recordKeystroke).not.toHaveBeenCalled();
  });

  it("ignores the injected VK_232 hook probe", async () => {
    await startRecording();
    fireEvent.keyDown(window, { key: "Unidentified", keyCode: 232 });
    await act(async () => {});
    expect(backend.recordKeystroke).not.toHaveBeenCalled();
  });

  it("stops its backend recorder and releases KEY_RECORDING on unmount", async () => {
    const { unmount, onChange } = await startRecording();
    expect(backend.setKeyRecording).toHaveBeenCalledWith(true);
    unmount();
    await act(async () => {});
    expect(backend.stopMacroRecording).toHaveBeenCalledOnce();
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("releases a backend start that completes after unmount", async () => {
    const start = deferred<void>();
    vi.mocked(backend.startMacroRecording).mockReturnValueOnce(start.promise);
    const onChange = vi.fn();
    const { unmount } = render(<SequenceStepEditor steps={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
    await act(async () => {});
    unmount();
    expect(backend.stopMacroRecording).not.toHaveBeenCalled();
    await act(async () => { start.resolve(); });
    expect(backend.stopMacroRecording).toHaveBeenCalledOnce();
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not start the recorder when KEY_RECORDING activation finishes after unmount", async () => {
    const activation = deferred<void>();
    vi.mocked(backend.setKeyRecording).mockReturnValueOnce(activation.promise);
    const { unmount } = render(<SequenceStepEditor steps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
    await act(async () => {});
    unmount();
    await act(async () => { activation.resolve(); });
    expect(backend.startMacroRecording).not.toHaveBeenCalled();
    expect(backend.stopMacroRecording).not.toHaveBeenCalled();
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
  });

  it("does not double-start while the backend start is pending", async () => {
    const start = deferred<void>();
    vi.mocked(backend.startMacroRecording).mockReturnValueOnce(start.promise);
    render(<SequenceStepEditor steps={[]} onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: i18n.t("picker.recordMacro") });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(backend.startMacroRecording).toHaveBeenCalledOnce();
    await act(async () => { start.resolve(); });
  });

  it("waits for pending writes before stopping and never applies a result after unmount", async () => {
    const write = deferred<number>();
    vi.mocked(backend.recordKeystroke).mockReturnValueOnce(write.promise);
    const { unmount, onChange } = await startRecording();
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stopRecording") }));
    await act(async () => {});
    expect(backend.stopMacroRecording).not.toHaveBeenCalled();
    unmount();
    await act(async () => { write.resolve(1); });
    expect(backend.stopMacroRecording).toHaveBeenCalledOnce();
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("waits for an unmounted editor's pending release before starting a new recording", async () => {
    const stop = deferred<backend.MacroRecording>();
    vi.mocked(backend.stopMacroRecording).mockReturnValueOnce(stop.promise);
    const first = await startRecording();
    first.unmount();
    await act(async () => {});
    render(<SequenceStepEditor steps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
    await act(async () => {});
    expect(backend.startMacroRecording).toHaveBeenCalledOnce();
    expect(backend.setKeyRecording).toHaveBeenCalledTimes(1);
    await act(async () => { stop.resolve({ steps: [], startedAt: 0, stoppedAt: 1 }); });
    await screen.findByRole("button", { name: i18n.t("picker.stopRecording") });
    expect(backend.startMacroRecording).toHaveBeenCalledTimes(2);
    expect(vi.mocked(backend.setKeyRecording).mock.calls.map(([on]) => on)).toEqual([true, false, true]);
    expect(first.onChange).not.toHaveBeenCalled();
  });

  it("keeps shortcut capture protected when an old sequence Stop finishes", async () => {
    const stop = deferred<backend.MacroRecording>();
    vi.mocked(backend.stopMacroRecording).mockReturnValueOnce(stop.promise);
    const sequence = await startRecording();
    sequence.unmount();
    const shortcut = render(<CaptureRow value="" placeholder="" ariaLabel="Shortcut" capturing onToggle={vi.fn()} />);
    await act(async () => {});
    await act(async () => { stop.resolve({ steps: [], startedAt: 0, stoppedAt: 1 }); });
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(backend.setKeyRecording).mock.calls.some(([on]) => !on)).toBe(false);
    shortcut.unmount();
    await act(async () => {});
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
  });

  it.each(["activation", "start", "stop", "write"])("surfaces %s failure and releases KEY_RECORDING", async (failure) => {
    const error = `${failure} failed`;
    if (failure === "activation") vi.mocked(backend.setKeyRecording).mockRejectedValueOnce(error);
    if (failure === "start") vi.mocked(backend.startMacroRecording).mockRejectedValueOnce(error);
    if (failure === "stop") vi.mocked(backend.stopMacroRecording).mockRejectedValueOnce(error);
    if (failure === "write") vi.mocked(backend.recordKeystroke).mockRejectedValueOnce(error);
    render(<SequenceStepEditor steps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
    if (failure === "stop" || failure === "write") {
      await screen.findByRole("button", { name: i18n.t("picker.stopRecording") });
      await act(async () => {});
      if (failure === "stop") fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stopRecording") }));
      else fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    }
    expect(await screen.findByText(`${failure} failed`)).toBeTruthy();
    await act(async () => {});
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    if (failure === "activation") expect(backend.startMacroRecording).not.toHaveBeenCalled();
  });

  it("stops at 200 steps even when more keys arrive in one event batch", async () => {
    const steps: SequenceStep[] = Array.from({ length: 200 }, () => ({ type: "send", value: "A" }));
    vi.mocked(backend.stopMacroRecording).mockResolvedValueOnce({ steps, startedAt: 0, stoppedAt: 1 });
    // The backend answers how many steps it holds: every chord is one.
    let held = 0;
    vi.mocked(backend.recordKeystroke).mockImplementation(() => Promise.resolve(++held));
    const { onChange } = await startRecording();
    await act(async () => {
      for (let index = 0; index < 205; index += 1) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
      }
    });
    expect(backend.recordKeystroke).toHaveBeenCalledTimes(200);
    expect(backend.stopMacroRecording).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(steps);
    expect(screen.getByText(i18n.t("picker.recordLimitReached", { max: 200 }))).toBeTruthy();
  });

  it("caps oversized backend recordings at 200 steps with a visible notice", async () => {
    const steps: SequenceStep[] = Array.from({ length: 201 }, () => ({ type: "send", value: "A" }));
    vi.mocked(backend.stopMacroRecording).mockResolvedValueOnce({ steps, startedAt: 0, stoppedAt: 1 });
    const { onChange } = await startRecording();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stopRecording") }));
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith(steps.slice(0, 200));
    expect(screen.getByText(i18n.t("picker.recordLimitReached", { max: 200 }))).toBeTruthy();
  });

  it("puts a recording in after the selected step instead of wiping the steps", async () => {
    const existing: SequenceStep[] = [{ type: "text", value: "Hi" }, { type: "text", value: "Bye" }];
    const recorded: SequenceStep[] = [{ type: "send", value: "A" }];
    vi.mocked(backend.stopMacroRecording).mockResolvedValueOnce({ steps: recorded, startedAt: 0, stoppedAt: 1 });
    const onChange = vi.fn();
    render(<SequenceStepEditor steps={existing} onChange={onChange} />);
    fireEvent.click(screen.getByText("«Hi»"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("picker.stopRecording") }));
    await act(async () => {});
    expect(onChange).toHaveBeenLastCalledWith([existing[0], recorded[0], existing[1]]);
  });

  it("forwards what a printable key typed, in the active layout, and none for a chord", async () => {
    vi.mocked(backend.recordKeystroke).mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await startRecording();
    await act(async () => {
      // "б" sits on the comma key of the Russian layout.
      fireEvent.keyDown(window, { key: "б", code: "Comma" });
      fireEvent.keyDown(window, { key: "Л", code: "KeyK", shiftKey: true });
      fireEvent.keyDown(window, { key: "l", code: "KeyL", ctrlKey: true });
    });
    expect(vi.mocked(backend.recordKeystroke).mock.calls).toEqual([
      [",", "б"],
      ["Shift+Л", "Л"],
      ["Ctrl+L", undefined],
    ]);
    // The counter shows the backend's step count, not the keys pressed.
    expect(screen.getByText(i18n.t("picker.recordingCount", { count: 2, max: 200 }))).toBeTruthy();
  });

  it("blocks manual additions at 200 steps and explains the limit", () => {
    const steps: SequenceStep[] = Array.from({ length: 200 }, () => ({ type: "send", value: "A" }));
    const onChange = vi.fn();
    render(<SequenceStepEditor steps={steps} onChange={onChange} />);
    const toolbar = within(screen.getByText(i18n.t("picker.sequenceSteps")).parentElement!);
    for (const key of ["addSend", "addText", "addSleep", "addLaunch"]) {
      const button = toolbar.getByRole("button", { name: `+ ${i18n.t(`picker.${key}`)}` });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("picker.sequenceStepLimit", { max: 200 }))).toBeTruthy();
  });
});

describe("SequenceStepEditor rows", () => {
  it("adds a step after the open one (or at the end), opens it, and deletes down to none", () => {
    const steps: SequenceStep[] = [{ type: "send", value: "Ctrl+L" }, { type: "text", value: "x" }];
    const onChange = vi.fn();
    const { rerender } = render(<SequenceStepEditor steps={steps} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: `+ ${i18n.t("picker.addSleep")}` }));
    expect(onChange.mock.lastCall?.[0].map((step: SequenceStep) => step.type)).toEqual(["send", "text", "sleep"]);
    fireEvent.click(screen.getByText("Ctrl+L"));
    expect(screen.getByText(i18n.t("picker.stepsGoAfter", { index: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `+ ${i18n.t("picker.addText")}` }));
    expect(onChange.mock.lastCall?.[0].map((step: SequenceStep) => step.type)).toEqual(["send", "text", "text"]);
    rerender(<SequenceStepEditor steps={[steps[0]!]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stepDelete", { index: 1 }) }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("duplicates a step right after it and opens the copy", () => {
    const steps: SequenceStep[] = [
      { type: "launch", value: "C:\\a.exe", args: ["-x"] },
      { type: "text", value: "x" },
    ];
    const onChange = vi.fn();
    const { rerender } = render(<SequenceStepEditor steps={steps} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stepDuplicate", { index: 1 }) }));
    const next = onChange.mock.lastCall?.[0] as SequenceStep[];
    expect(next).toEqual([steps[0], steps[0], steps[1]]);
    // A copy, not the same object: editing one leaves the other alone.
    expect(next[1]).not.toBe(steps[0]);
    expect((next[1] as { args: string[] }).args).not.toBe((steps[0] as { args: string[] }).args);
    rerender(<SequenceStepEditor steps={next} onChange={onChange} />);
    const rows = screen.getAllByRole("button", { expanded: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("2");
  });

  it("shows the step count and the estimated length, a window wait as up to its timeout", () => {
    const seconds = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
    const steps: SequenceStep[] = [
      { type: "send", value: "A", delayMs: 100, repeat: 3 },
      { type: "sleep", delayMs: 1000 },
      { type: "text", value: "x", delayMs: 200 },
      { type: "send", value: "B", delayMs: 500, repeat: 0 },
    ];
    const { rerender } = render(<SequenceStepEditor steps={steps} onChange={vi.fn()} />);
    expect(screen.getByText(i18n.t("picker.sequenceTotal", { count: 4, seconds: seconds(1.5) }))).toBeTruthy();
    rerender(<SequenceStepEditor steps={[...steps, { type: "waitWindow", exe: "a.exe", timeoutMs: 5000 }]} onChange={vi.fn()} />);
    expect(
      screen.getByText(i18n.t("picker.sequenceTotalWithWait", { count: 5, seconds: seconds(1.5), max: seconds(6.5) })),
    ).toBeTruthy();
  });
});

describe("SequenceStepEditor Send step Record", () => {
  function renderSend(onChange = vi.fn()) {
    render(<SequenceStepEditor steps={[{ type: "send", value: "" }, { type: "text", value: "x" }]} onChange={onChange} />);
    fireEvent.click(screen.getByText(i18n.t("picker.stepNoValue")));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.sendStepRecord", { index: 1 }) }));
    return onChange;
  }

  it("puts one chord into the field, as the recorder writes it, and ends the capture", async () => {
    const onChange = renderSend();
    await act(async () => {});
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Unidentified", keyCode: 232 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "l", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith([{ type: "send", value: "Ctrl+Shift+L" }, { type: "text", value: "x" }]);
    await act(async () => {});
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    // Captured once: the next key is ordinary typing again.
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("Esc cancels without changing the step", async () => {
    const onChange = renderSend();
    await act(async () => {});
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled();
    expect(backend.setKeyRecording).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: i18n.t("picker.sendStepRecord", { index: 1 }) })).toBeTruthy();
  });
});
