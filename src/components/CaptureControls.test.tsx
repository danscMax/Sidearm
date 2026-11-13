import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { pickExecutablePath } from "../lib/backend";
import { CaptureControls } from "./CaptureControls";
import { ExeMatchField } from "./ExeMatchField";

vi.mock("../lib/backend", () => ({ pickExecutablePath: vi.fn() }));
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

  it("offers only executables in Browse and rejects a returned shortcut", async () => {
    vi.mocked(pickExecutablePath).mockResolvedValueOnce({ name: "My editor.lnk", path: "C:\\My editor.lnk" });
    const change = vi.fn();
    render(<ExeMatchField label="Application" exe="" onChange={change} placeholder=""
      browseTitle="Choose" browseFilter="Applications" browseLabel="Browse" />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(pickExecutablePath).toHaveBeenCalledWith({ title: "Choose", filterName: "Applications", extensions: ["exe"] }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("newRule.exeOnly"));
  });
});
