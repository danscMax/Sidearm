import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Toolbar } from "./Toolbar";

afterEach(() => {
  cleanup();
});

function renderToolbar(props: {
  runtimeProfileName: string | null;
  editedProfileName: string | null;
}) {
  return render(
    <Toolbar
      heading="Назначения"
      runtimeProfileName={props.runtimeProfileName}
      editedProfileName={props.editedProfileName}
      undoCount={0}
      redoCount={0}
      viewState="idle"
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onOpenCommandPalette={vi.fn()}
    />,
  );
}

describe("Toolbar live-profile badge", () => {
  it("hides the badge when the runtime is not running", () => {
    const { container } = renderToolbar({
      runtimeProfileName: null,
      editedProfileName: "Game",
    });

    expect(container.querySelector(".toolbar__profile")).toBeNull();
  });

  it("shows the live profile without a warning when it is the one being edited", () => {
    const { container } = renderToolbar({
      runtimeProfileName: "Main",
      editedProfileName: "Main",
    });

    const badge = container.querySelector(".toolbar__profile");
    expect(badge).not.toBeNull();
    expect(screen.getByText("Main")).toBeTruthy();
    expect(badge?.classList.contains("toolbar__profile--warn")).toBe(false);
  });

  it("warns when the edited profile is not the live one", () => {
    const { container } = renderToolbar({
      runtimeProfileName: "Main",
      editedProfileName: "Game",
    });

    const badge = container.querySelector(".toolbar__profile");
    expect(badge?.classList.contains("toolbar__profile--warn")).toBe(true);
    // Tooltip names both profiles — that pairing is the whole point of the warning.
    expect(badge?.getAttribute("title")).toContain("Main");
    expect(badge?.getAttribute("title")).toContain("Game");
  });
});
