import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { AppConfig } from "../lib/config";
import { makeConfig } from "../lib/test-fixtures";
import { CaptureRow } from "./action-picker/shared/CaptureRow";
import { ChipEditor } from "./ChipEditor";
import { ExeMatchField } from "./ExeMatchField";
import { CommandPalette } from "./CommandPalette";
import { GenericDeviceView } from "./GenericDeviceView";
import { TextSnippetEditor } from "./action-picker/TextSnippetEditor";
import { AppMappingModal } from "./AppMappingModal";
import { ControlPropertiesPanel } from "./ControlPropertiesPanel";
import { ProfileSettings } from "./settings/ProfileSettings";

vi.mock("../lib/backend", () => ({
  getExeIcon: vi.fn().mockResolvedValue(null),
  readDeviceImage: vi.fn().mockResolvedValue(null),
  pickExecutablePath: vi.fn().mockResolvedValue(null),
  setKeyRecording: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("form field names", () => {
  it("keeps the shortcut capture name when its placeholder changes", () => {
    const props = { value: "Ctrl+H", ariaLabel: "Global shortcut", placeholder: "", capturing: false, onToggle: vi.fn() };
    const { rerender } = render(<CaptureRow {...props} />);
    expect(screen.getByRole("textbox", { name: "Global shortcut" }).getAttribute("readonly")).not.toBeNull();
    rerender(<CaptureRow {...props} capturing placeholder="Press a key" />);
    expect(screen.getByRole("textbox", { name: "Global shortcut" })).toBeTruthy();
  });

  it("names chip entry even when existing chips hide the placeholder", () => {
    const change = vi.fn();
    render(<ChipEditor values={["editor"]} onChange={change} ariaLabel="Window title" />);
    const input = screen.getByRole("textbox", { name: "Window title" });
    fireEvent.change(input, { target: { value: "document" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenCalledWith(["editor", "document"]);
    fireEvent.click(screen.getByRole("button", { name: "editor" }));
    expect(screen.getAllByRole("textbox", { name: "Window title" })).toHaveLength(2);
  });

  it("associates the executable label with its input", () => {
    render(<ExeMatchField label="Application" exe="editor.exe" onChange={vi.fn()} placeholder=""
      browseTitle="Choose application" browseFilter="Applications" browseLabel="Browse" />);
    expect(screen.getByRole("textbox", { name: "Application" })).toBeTruthy();
  });

  it("names the command combobox independently of the dialog", () => {
    render(<CommandPalette onClose={vi.fn()} onExecute={vi.fn()} bindings={[]} actionsById={new Map()}
      profileNameById={new Map()} snippets={[]} recent={[]} onSelectBinding={vi.fn()} onSelectSnippet={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: i18n.t("command.placeholder") })).toBeTruthy();
  });

  it("names device rename and preserves the Enter commit", () => {
    const rename = vi.fn();
    render(<GenericDeviceView entries={[]} device={{ id: "custom", name: "Pad", builtin: false }}
      selectedLayer="standard" multiSelectedControlIds={new Set()} onSelectControl={vi.fn()} onToggleMultiSelect={vi.fn()}
      onOpenActionPicker={vi.fn()} onSelectLayer={vi.fn()} onAddControl={vi.fn()} onEditControl={vi.fn()}
      onRemoveControl={vi.fn()} onRenameDevice={rename} onDeleteDevice={vi.fn()} onPickImage={vi.fn()}
      onPlaceHotspot={vi.fn()} startRenaming />);
    const input = screen.getByRole("textbox", { name: i18n.t("settings.deviceNameHeader") });
    fireEvent.change(input, { target: { value: "Work pad" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rename).toHaveBeenCalledWith("Work pad");
  });

  it("names the token textarea while keeping its overlay out of accessibility", () => {
    render(<TextSnippetEditor draft={{ text: "Hello {date}", pasteMode: "clipboardPaste" }} onChange={vi.fn()}
      library={[]} saveToLibrary={false} onToggleSaveToLibrary={vi.fn()} onPickName={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: i18n.t("picker.textLabel") })).toBeTruthy();
  });

  it("names the rule profile selector", () => {
    render(<AppMappingModal mode="create" value={{ id: "rule", exe: "editor.exe", profileId: "p1", enabled: true, priority: 1 }}
      profiles={makeConfig().profiles} onChange={vi.fn()} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: i18n.t("debug.profile") })).toBeTruthy();
  });

  it("names capability status and preserves a deferred config update", () => {
    const config = makeConfig();
    const update = vi.fn();
    render(<ControlPropertiesPanel selectedControl={config.physicalControls[0]} selectedBinding={null} selectedAction={null}
      selectedEncoder={null} snippetById={new Map()} selectedLayer="standard" updateDraft={update} />);
    fireEvent.change(screen.getByRole("combobox", { name: i18n.t("properties.status") }), { target: { value: "needsValidation" } });
    const changed = update.mock.calls[0][0](config) as AppConfig;
    expect(changed.physicalControls.find((control) => control.id === config.physicalControls[0].id)?.capabilityStatus).toBe("needsValidation");
  });

  it.each([
    { field: "name", label: "settings.nameLabel", value: "Renamed", expected: "Renamed" },
    { field: "description", label: "settings.descriptionLabel", value: "Details", expected: "Details" },
    { field: "description", label: "settings.descriptionLabel", value: "", expected: undefined },
  ] as const)("preserves deferred profile $field edit to '$value'", ({ field, label, value, expected }) => {
    const config = makeConfig();
    config.profiles[0].description = "Existing";
    const update = vi.fn();
    render(<ProfileSettings activeConfig={config} activeProfile={config.profiles[0]} effectiveProfileId="p1"
      updateDraft={update} setSelectedProfileId={vi.fn()} setConfirmModal={vi.fn()} setError={vi.fn()} showToast={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t(label) }), { target: { value } });
    const changed = update.mock.calls[0][0](config) as AppConfig;
    expect(changed.profiles[0][field]).toBe(expected);
  });
});
