import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import i18n from "../../i18n";
import { SequenceStepEditor } from "./SequenceStepEditor";
import * as backend from "../../lib/backend";

// Keep every real backend export (they invoke Tauri, harmlessly stubbed in
// test-setup) but spy on the three recorder calls so we can assert the chord
// string the keydown handler forwards.
vi.mock("../../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/backend")>();
  return {
    ...actual,
    recordKeystroke: vi.fn(() => Promise.resolve()),
    startMacroRecording: vi.fn(() => Promise.resolve()),
    stopMacroRecording: vi.fn(() => Promise.resolve({ steps: [] })),
  };
});

afterEach(() => {
  cleanup();
  vi.mocked(backend.recordKeystroke).mockClear();
});

/** Render the editor and enter recording mode (the window keydown listener is
 *  only attached while recording). */
async function startRecording() {
  render(<SequenceStepEditor steps={[]} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("picker.recordMacro") }));
  await screen.findByRole("button", { name: i18n.t("picker.stopRecording") });
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
    expect(backend.recordKeystroke).toHaveBeenCalledWith(
      expect.stringMatching(/^Ctrl\+Shift\+Alt\+Win\+/),
    );
  });

  it("captures the Win (Meta) modifier that the old recorder dropped", async () => {
    await startRecording();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", metaKey: true }),
    );
    expect(backend.recordKeystroke).toHaveBeenCalledWith(expect.stringMatching(/^Win\+/));
  });

  it("ignores bare modifier presses (no chord recorded)", async () => {
    await startRecording();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(backend.recordKeystroke).not.toHaveBeenCalled();
  });
});
