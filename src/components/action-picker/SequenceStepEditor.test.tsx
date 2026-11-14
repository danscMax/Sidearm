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
    recordKeystroke: vi.fn(() => Promise.resolve()),
    startMacroRecording: vi.fn(() => Promise.resolve()),
    stopMacroRecording: vi.fn(() => Promise.resolve({ steps: [], startedAt: 0, stoppedAt: 1 })),
    setKeyRecording: vi.fn(() => Promise.resolve()),
  };
});

beforeEach(() => {
  vi.mocked(backend.recordKeystroke).mockReset().mockResolvedValue(undefined);
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
    );
  });

  it("captures the Win (Meta) modifier that the old recorder dropped", async () => {
    await startRecording();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", metaKey: true }),
    );
    await act(async () => {});
    expect(backend.recordKeystroke).toHaveBeenCalledWith(expect.stringMatching(/^Win\+/));
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
    const write = deferred<void>();
    vi.mocked(backend.recordKeystroke).mockReturnValueOnce(write.promise);
    const { unmount, onChange } = await startRecording();
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.stopRecording") }));
    await act(async () => {});
    expect(backend.stopMacroRecording).not.toHaveBeenCalled();
    unmount();
    await act(async () => { write.resolve(); });
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
});
