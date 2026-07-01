import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConfirmModal } from "./ConfirmModal";

afterEach(() => {
  cleanup();
});

describe("ConfirmModal", () => {
  it("renders and runs the secondary confirmation action", async () => {
    const onConfirm = vi.fn();
    const onSecondaryConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmModal
        title="Import config"
        message="Choose import mode"
        confirmLabel="Replace"
        onConfirm={onConfirm}
        secondaryConfirmLabel="Merge"
        onSecondaryConfirm={onSecondaryConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(onSecondaryConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("surfaces confirmation action failures", async () => {
    const onConfirm = vi.fn(() => {
      throw new Error("Import failed");
    });
    const onCancel = vi.fn();

    render(
      <ConfirmModal
        title="Import config"
        message="Choose import mode"
        confirmLabel="Replace"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Import failed");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
