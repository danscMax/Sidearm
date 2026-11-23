import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useControlInteractions } from "../../hooks/useControlInteractions";
import type { ControlSurfaceEntry } from "../../lib/constants";
import { actionLabel, tooltipText, withOfflineAssignment } from "../../lib/mouse-visual";
import { makeAction, makeConfig } from "../../lib/test-fixtures";
import type { OfflineControl, OfflinePreview } from "../../lib/onboard-mapping";
import { LegendCell } from "./LegendCell";

afterEach(cleanup);

function Cell({ entry }: { entry: ControlSurfaceEntry }) {
  const interaction = useControlInteractions({ entries: [entry], onSelectControl: vi.fn(), onToggleMultiSelect: vi.fn(), onOpenActionPicker: vi.fn() });
  return <LegendCell entry={entry} controlId={entry.control.id} interaction={interaction} selected={false} badge="1" label={actionLabel(entry)} tooltip={tooltipText(entry, "")} />;
}

const action = makeAction({ type: "mouseAction", displayName: "Middle click", payload: { action: "middleClick" } });
const config = makeConfig({ actions: [action], bindings: [{ id: "live", profileId: "p1", layer: "standard", controlId: "thumb_01", actionId: action.id, label: "Middle", enabled: true }] });
const base: ControlSurfaceEntry = { control: config.physicalControls[1], binding: config.bindings[0], action, mapping: null, isSelected: false };

it.each(["own", "inherited"] as const)("shows the %s firmware badge and never makes offline cells draggable", (kind) => {
  const entry = withOfflineAssignment(config, "p1", "offline", base, preview({ kind, actionId: action.id }));
  render(<Cell entry={entry} />);
  expect(screen.getByText(i18n.t(`offline.${kind}`))).toBeTruthy();
  expect(screen.getByText(entry.action!.displayName)).toBeTruthy();
  expect(screen.getByRole("button").draggable).toBe(false);
});

it("dims silence and shows what the same button does in Sidearm", () => {
  render(<Cell entry={withOfflineAssignment(config, "p1", "offline", base, preview({ kind: "silent" }))} />);
  expect(screen.getByText(i18n.t("offline.silent"))).toBeTruthy();
  expect(screen.getByText(i18n.t("offline.liveAction", { action: action.displayName }))).toBeTruthy();
  expect(screen.getByRole("button").classList.contains("btn-legend__cell--silent")).toBe(true);
});

it("keeps the live S mark and gives it the exact firmware result", () => {
  const entry = { ...base, sidearmOnly: true, offlineActionLabel: "Ctrl+C" };
  const { container } = render(<Cell entry={entry} />);
  expect(container.querySelector(".btn-legend__live")?.getAttribute("data-tip")).toBe(i18n.t("offline.tooltip", { action: "Ctrl+C" }));
});

it("renders a calm memory icon with tooltip when stored in mouse memory", () => {
  const entry = { ...base, inMouse: true };
  const { container } = render(<Cell entry={entry} />);
  expect(container.querySelector(".btn-legend__memory")?.getAttribute("data-tip")).toBe(i18n.t("offline.inMouseTooltip"));
  expect(tooltipText(entry, "")).toContain(i18n.t("offline.inMouseTooltip"));
});

function preview(control: Partial<OfflineControl>): OfflinePreview {
  return { target: { state: "written" }, controls: [{ controlId: "thumb_01", layer: "offline", kind: "preserved", editable: true, ...control }] };
}

it.each([
  [{ kind: "preserved" }, "offline.preserved", false],
  [{ kind: "role", role: "profileButton", editable: false }, "offline.role.profileButton", false],
  [{ kind: "unavailable", editable: false }, "offline.unavailable", true],
] satisfies [Partial<OfflineControl>, string, boolean][])("renders %j cells", (control, key, dimmed) => {
  render(<Cell entry={withOfflineAssignment(config, "p1", "offline", base, preview(control))} />);
  expect(screen.getByText(i18n.t(key))).toBeTruthy();
  expect(screen.getByRole("button").classList.contains("btn-legend__cell--dimmed")).toBe(dimmed);
});
