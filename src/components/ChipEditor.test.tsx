import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { ChipEditor } from "./ChipEditor";
import { LaunchEditor } from "./action-picker/LaunchEditor";

afterEach(cleanup);

describe("literal launch arguments", () => {
  it("keeps repeated arguments in the launch editor", () => {
    function Harness() {
      const [draft, setDraft] = useState({ target: "node.exe", args: ["-r", "a.js"], workingDir: "" });
      return <LaunchEditor draft={draft} onChange={setDraft} />;
    }
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: i18n.t("picker.launchArgsLabel") });
    fireEvent.change(input, { target: { value: "-r" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("button", { name: "-r" })).toHaveLength(2);
  });

  it("preserves commas and surrounding whitespace and edits duplicates in place", () => {
    const change = vi.fn();
    render(<ChipEditor values={["-r", "b.js"]} onChange={change} ariaLabel="Arguments" literalValues />);
    const input = screen.getByRole("textbox", { name: "Arguments" });
    fireEvent.change(input, { target: { value: "  --list=a" } });
    expect(fireEvent.keyDown(input, { key: "," })).toBe(true);
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  --list=a,b  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenLastCalledWith(["-r", "b.js", "  --list=a,b  "]);
    fireEvent.click(screen.getByRole("button", { name: "b.js" }));
    const editing = screen.getAllByRole("textbox", { name: "Arguments" })[0];
    fireEvent.change(editing, { target: { value: "-r" } });
    fireEvent.keyDown(editing, { key: "Enter" });
    expect(change).toHaveBeenLastCalledWith(["-r", "-r"]);
  });

  it("retains trimming, comma commit and uniqueness for filters", () => {
    const change = vi.fn();
    render(<ChipEditor values={["editor"]} onChange={change} ariaLabel="Filters" />);
    const input = screen.getByRole("textbox", { name: "Filters" });
    fireEvent.change(input, { target: { value: " editor " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " document " } });
    fireEvent.keyDown(input, { key: "," });
    expect(change).toHaveBeenCalledWith(["editor", "document"]);
  });
});
