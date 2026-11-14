import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../i18n";
import * as backend from "../lib/backend";
import { makeConfig } from "../lib/test-fixtures";
import type { ImportedConfig, ParsedSynapseProfiles } from "../lib/synapse-import";
import { SynapseImportModal } from "./SynapseImportModal";

vi.mock("../lib/backend", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/backend")>(),
  importSynapseIntoConfig: vi.fn(),
}));
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });
afterEach(cleanup);

const parsed: ParsedSynapseProfiles = {
  sourceKind: "synapseV4", sourcePath: "profiles", warnings: [],
  profiles: [{ synapseGuid: "s1", name: "Imported", bindings: [], macros: [] }],
};
const summary = { profilesAdded: 1, bindingsAdded: 0, actionsAdded: 0, macrosAdded: 0, skipped: 0 };

it("rejects a delayed import when its config base changed and permits an explicit retry", async () => {
  const base = makeConfig();
  const latest = { ...base, profiles: base.profiles.map((profile) => ({ ...profile, name: `${profile.name}!` })) };
  let resolve!: (result: ImportedConfig) => void;
  vi.mocked(backend.importSynapseIntoConfig).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const onImported = vi.fn();
  const setError = vi.fn();
  const props = { parsed, activeConfig: base, onImported, setError, onCancel: vi.fn() };
  const { rerender } = render(<SynapseImportModal {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Import.*1/i }));
  rerender(<SynapseImportModal {...props} activeConfig={latest} />);
  await act(async () => resolve({ config: base, summary, warnings: [] }));
  expect(onImported).not.toHaveBeenCalled();
  expect(setError).toHaveBeenCalledWith({ code: "config_changed_on_disk", message: i18n.t("synapseImport.configChanged") });
  expect(backend.importSynapseIntoConfig).toHaveBeenCalledTimes(1);
  vi.mocked(backend.importSynapseIntoConfig).mockResolvedValueOnce({ config: latest, summary, warnings: [] });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Import.*1/i })));
  expect(backend.importSynapseIntoConfig).toHaveBeenLastCalledWith(parsed, expect.anything(), latest);
  expect(onImported).toHaveBeenCalledWith(latest, summary);
});

it("applies an import whose config base is still current", async () => {
  const base = makeConfig();
  vi.mocked(backend.importSynapseIntoConfig).mockResolvedValueOnce({ config: base, summary, warnings: [] });
  const onImported = vi.fn();
  const setError = vi.fn();
  render(<SynapseImportModal parsed={parsed} activeConfig={base} onImported={onImported} setError={setError} onCancel={vi.fn()} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Import.*1/i })));
  expect(onImported).toHaveBeenCalledWith(base, summary);
  expect(setError).not.toHaveBeenCalled();
});

it.each([null, 1])("rejects an import when reload revision becomes %s before new props commit", async (nextRevision) => {
  const base = makeConfig();
  let revision: number | null = 0;
  let resolve!: (result: ImportedConfig) => void;
  vi.mocked(backend.importSynapseIntoConfig).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const onImported = vi.fn();
  const setError = vi.fn();
  render(<SynapseImportModal parsed={parsed} activeConfig={base} getConfigRevision={() => revision}
    onImported={onImported} setError={setError} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Import.*1/i }));
  revision = nextRevision;
  await act(async () => resolve({ config: base, summary, warnings: [] }));
  expect(onImported).not.toHaveBeenCalled();
  expect(setError).toHaveBeenCalledWith({ code: "config_changed_on_disk", message: i18n.t("synapseImport.configChanged") });
});

it.each([
  ["en", 1, 1, "Import 1 profile (1 binding)"],
  ["en", 2, 5, "Import 2 profiles (5 bindings)"],
  ["ru", 1, 1, "Импортировать 1 профиль (1 назначение)"],
  ["ru", 3, 2, "Импортировать 3 профиля (2 назначения)"],
  ["ru", 5, 11, "Импортировать 5 профилей (11 назначений)"],
])("declines the submit label in %s for %i profiles and %i bindings", async (language, profiles, bindings, label) => {
  await i18n.changeLanguage(language);
  const many: ParsedSynapseProfiles = {
    ...parsed,
    profiles: Array.from({ length: profiles }, (_, i) => ({
      synapseGuid: `s${i}`, name: `P${i}`, macros: [],
      // Only the count matters for the label.
      bindings: i === 0 ? Array.from({ length: bindings }, () => ({}) as ParsedSynapseProfiles["profiles"][number]["bindings"][number]) : [],
    })),
  };
  render(<SynapseImportModal parsed={many} activeConfig={makeConfig()} onImported={vi.fn()} setError={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("button", { name: label })).toBeTruthy();
});

it("does not start an import while an external reload is pending", () => {
  const setError = vi.fn();
  render(<SynapseImportModal parsed={parsed} activeConfig={makeConfig()} getConfigRevision={() => null}
    onImported={vi.fn()} setError={setError} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Import.*1/i }));
  expect(backend.importSynapseIntoConfig).not.toHaveBeenCalled();
  expect(setError).toHaveBeenCalledWith({ code: "config_changed_on_disk", message: i18n.t("synapseImport.configChanged") });
});
