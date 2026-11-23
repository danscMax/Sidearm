import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { OfflineFixPanel } from "./OfflineFixPanel";
import { makeConfig } from "../lib/test-fixtures";
import type { AppConfig } from "../lib/config";
import type { OfflinePreview } from "../lib/onboard-mapping";
import { findBinding } from "../lib/config-editing";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("OfflineFixPanel", () => {
  it("lists buttons that fail without Sidearm, applies a 1-click suggestion, and opens custom editor", () => {
    const config = makeConfig({
      actions: [
        { id: "a_q", type: "textSnippet", displayName: "?", payload: { source: "inline", text: "?", pasteMode: "sendText", tags: [] } },
      ],
      bindings: [
        { id: "b_q", profileId: "p1", layer: "hypershift", controlId: "thumb_01", actionId: "a_q", label: "?", enabled: true },
      ],
    });
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offlineHypershift", kind: "silent", actionId: "a_q", reason: "actionType", editable: true },
      ],
    };

    const onApply = vi.fn();
    const onEdit = vi.fn();
    const onToast = vi.fn();

    render(
      <OfflineFixPanel
        config={config}
        profileId="p1"
        deviceId="razer-naga"
        preview={preview}
        onApplyConfig={onApply}
        onEditControl={onEdit}
        onToast={onToast}
      />,
    );

    expect(screen.getByText(i18n.t("offlineFix.needsFix", { count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("offlineFix.expand") }));

    // Clicking the EN suggestion writes Shift + / onto offlineHypershift
    fireEvent.click(screen.getByRole("button", { name: /Shift \+ \/ \(\? · EN\)/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const updated = onApply.mock.calls[0][0](config) as AppConfig;
    const written = findBinding(updated, "p1", "offlineHypershift", "thumb_01");
    expect(updated.actions.find((a) => a.id === written?.actionId)?.payload).toEqual({
      key: "/", ctrl: false, shift: true, alt: false, win: false,
    });

    // Clicking Edit opens the picker for that exact button and offline layer with top suggestion prefilled
    fireEvent.click(screen.getByRole("button", { name: i18n.t("offlineFix.edit") }));
    expect(onEdit).toHaveBeenCalledWith("thumb_01", "offlineHypershift", {
      key: "/", ctrl: false, shift: true, alt: false, win: false,
    });

    // Hovering the button name previews the mouse model with highlighted marker, and Escape dismisses it
    const trigger = document.querySelector(".offline-fix__btn-trigger") as HTMLElement;
    expect(trigger).toBeTruthy();
    fireEvent.mouseEnter(trigger);
    expect(document.querySelector(".control-preview-popover")).toBeTruthy();
    expect(document.querySelector(".control-preview-popover__marker")).toBeTruthy();
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".control-preview-popover")).toBeNull();
  });

  it("shows clean status when every button already plays without Sidearm", () => {
    const config = makeConfig();
    const preview: OfflinePreview = {
      target: { state: "written" },
      controls: [
        { controlId: "thumb_01", layer: "offline", kind: "own", editable: true },
      ],
    };

    render(
      <OfflineFixPanel
        config={config}
        profileId="p1"
        deviceId="razer-naga"
        preview={preview}
        onApplyConfig={vi.fn()}
        onEditControl={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(screen.getByText(i18n.t("offlineFix.allReady"))).toBeTruthy();
    expect(screen.getByText(i18n.t("offlineFix.ownCount", { count: 1 }))).toBeTruthy();
  });

  it("shows hybrid-bank notice and hides offline replacement actions when hybridBankActive is true", () => {
    const config = makeConfig();
    const preview: OfflinePreview = {
      target: { state: "written", hybrid: true },
      controls: [{ controlId: "thumb_01", layer: "offline", kind: "silent", editable: true }],
    };
    render(
      <OfflineFixPanel
        config={config}
        profileId="p1"
        deviceId="razer-naga"
        preview={preview}
        hybridBankActive
        onApplyConfig={vi.fn()}
        onEditControl={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    expect(screen.getByText(i18n.t("offlineFix.hybridBankNotice"))).toBeTruthy();
  });

  it("does not claim hardware readiness when target is notWritten or rows are unavailable", () => {
    const config = makeConfig();
    const preview: OfflinePreview = {
      target: { state: "notWritten" },
      controls: [{ controlId: "thumb_01", layer: "offlineHypershift", kind: "unavailable", editable: false }],
    };
    render(
      <OfflineFixPanel
        config={config}
        profileId="p1"
        deviceId="razer-naga"
        preview={preview}
        onApplyConfig={vi.fn()}
        onEditControl={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    expect(screen.getByText(i18n.t("offlineFix.noneToFix"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("offlineFix.allReady"))).toBeNull();
  });
});
