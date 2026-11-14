import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { pickExecutablePath, resolveShortcutTarget } from "../lib/backend";
import { CaptureControls } from "./CaptureControls";
import { ExeMatchField } from "./ExeMatchField";

vi.mock("../lib/backend", () => ({
  pickExecutablePath: vi.fn(),
  resolveShortcutTarget: vi.fn(),
  normalizeCommandError: (error: unknown) => ({ code: "x", message: String(error) }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("application executable selection", () => {
  it("rejects shortcuts visibly instead of inventing a process name", () => {
    const dropped = vi.fn();
    const { container } = render(<CaptureControls countdown={null} delayMs={1000} onSelectDelay={vi.fn()}
      onCapture={vi.fn()} onDropExe={dropped} />);
    const zone = container.querySelector(".new-rule__dropzone")!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File([], "My editor.lnk")] } });
    expect(dropped).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("newRule.exeOnly"));
    fireEvent.drop(zone, { dataTransfer: { files: [new File([], "Code.EXE")] } });
    expect(dropped).toHaveBeenCalledWith("code.exe");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes the program a picked shortcut starts, and says why another shortcut cannot be used", async () => {
    vi.mocked(pickExecutablePath).mockResolvedValue({ name: "My editor.lnk", path: "C:\\My editor.lnk" });
    vi.mocked(resolveShortcutTarget).mockResolvedValueOnce("C:\\Apps\\Editor\\editor.exe");
    const change = vi.fn();
    render(<ExeMatchField label="Application" exe="" onChange={change} placeholder=""
      browseTitle="Choose" browseFilter="Applications" browseLabel="Browse" />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("editor.exe", "C:\\Apps\\Editor\\editor.exe"));
    expect(pickExecutablePath).toHaveBeenCalledWith({ title: "Choose", filterName: "Applications", extensions: ["exe", "lnk"] });
    vi.mocked(resolveShortcutTarget).mockRejectedValueOnce("starts a document");
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("starts a document"));
    expect(change).toHaveBeenCalledTimes(1);
  });
});
