import { describe, it, expect } from "vitest";
import {
  applyBindingImport,
  buildBindingExport,
  copyBindingBetweenProfiles,
  isValidBindingExport,
} from "./config-editing";
import type { Action, AppConfig, Binding, ControlId, SnippetLibraryItem } from "./config";

function minimalConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    settings: {
      fallbackProfileId: "",
      theme: "dark",
      startWithWindows: false,
      minimizeToTray: false,
      debugLogging: false,
      osdEnabled: true,
      osdDurationMs: 2000,
      osdPosition: "bottomRight",
      osdFontSize: "medium",
      osdAnimation: "slideIn",
    },
    profiles: [],
    physicalControls: [],
    encoderMappings: [],
    appMappings: [],
    bindings: [],
    actions: [],
    snippetLibrary: [],
    ...over,
  };
}

function shortcutAction(id: string, name: string): Action {
  return {
    id,
    type: "shortcut",
    payload: { key: "V", ctrl: true, shift: false, alt: false, win: false },
    displayName: name,
  } as Action;
}

function binding(over: Partial<Binding> = {}): Binding {
  return {
    id: "binding-1",
    profileId: "main",
    layer: "standard",
    controlId: "thumb_01" as ControlId,
    label: "Paste",
    actionId: "action-1",
    enabled: true,
    ...over,
  };
}

describe("single-binding transfer round-trip", () => {
  it("exports then imports a shortcut binding onto a fresh control", () => {
    const source = minimalConfig({
      bindings: [binding()],
      actions: [shortcutAction("action-1", "Paste")],
    });
    const data = buildBindingExport(source, "binding-1");
    expect(data).not.toBeNull();
    expect(data!.kind).toBe("binding");
    expect(data!.referencedSnippets).toHaveLength(0);

    const target = minimalConfig();
    const out = applyBindingImport(target, data!, "code", "hypershift", "thumb_05" as ControlId);

    expect(out.bindings).toHaveLength(1);
    const b = out.bindings[0];
    expect(b.profileId).toBe("code");
    expect(b.layer).toBe("hypershift");
    expect(b.controlId).toBe("thumb_05");
    expect(b.actionId).not.toBe("action-1"); // fresh id
    const a = out.actions.find((x) => x.id === b.actionId);
    expect(a?.displayName).toBe("Paste");
  });

  it("carries a libraryRef snippet and re-points it with a fresh id", () => {
    const snippet: SnippetLibraryItem = {
      id: "snip-1",
      name: "Greeting",
      text: "Hello",
      pasteMode: "sendText",
      tags: [],
    };
    const action = {
      id: "action-1",
      type: "textSnippet",
      payload: { source: "libraryRef", snippetId: "snip-1" },
      displayName: "Greeting",
    } as Action;
    const source = minimalConfig({
      bindings: [binding({ actionId: "action-1", label: "Greeting" })],
      actions: [action],
      snippetLibrary: [snippet],
    });

    const data = buildBindingExport(source, "binding-1");
    expect(data!.referencedSnippets).toHaveLength(1);

    const out = applyBindingImport(minimalConfig(), data!, "main", "standard", "thumb_02" as ControlId);
    expect(out.snippetLibrary).toHaveLength(1);
    const importedSnippet = out.snippetLibrary[0];
    expect(importedSnippet.id).not.toBe("snip-1"); // fresh id
    expect(importedSnippet.text).toBe("Hello");
    const importedAction = out.actions[0];
    expect(importedAction.type).toBe("textSnippet");
    expect(
      importedAction.type === "textSnippet" && importedAction.payload.source === "libraryRef"
        ? importedAction.payload.snippetId
        : null,
    ).toBe(importedSnippet.id);
  });

  it("replaces an existing binding on the target slot and prunes its action", () => {
    const target = minimalConfig({
      bindings: [binding({ id: "binding-old", actionId: "action-old", label: "Old" })],
      actions: [shortcutAction("action-old", "Old")],
    });
    const data = buildBindingExport(
      minimalConfig({ bindings: [binding()], actions: [shortcutAction("action-1", "New")] }),
      "binding-1",
    );
    const out = applyBindingImport(target, data!, "main", "standard", "thumb_01" as ControlId);

    expect(out.bindings).toHaveLength(1);
    expect(out.bindings[0].actionId).not.toBe("action-old");
    // The orphaned old action is pruned.
    expect(out.actions.some((a) => a.id === "action-old")).toBe(false);
  });

  it("rejects an invalid export envelope", () => {
    expect(isValidBindingExport(null)).toBe(false);
    expect(isValidBindingExport({ kind: "snippet" })).toBe(false);
    expect(isValidBindingExport({ kind: "binding", action: {}, binding: {}, referencedSnippets: [] })).toBe(true);
  });
});

describe("copyBindingBetweenProfiles", () => {
  it("copies a shortcut binding to another profile, leaving the source intact", () => {
    const config = minimalConfig({
      bindings: [binding()],
      actions: [shortcutAction("action-1", "Paste")],
    });
    const out = copyBindingBetweenProfiles(config, "binding-1", "code", "standard", "thumb_01" as ControlId);

    expect(out.bindings.filter((b) => b.profileId === "main")).toHaveLength(1); // source kept
    const copied = out.bindings.find((b) => b.profileId === "code");
    expect(copied).toBeDefined();
    expect(copied!.actionId).not.toBe("action-1");
    expect(out.actions.find((a) => a.id === copied!.actionId)?.displayName).toBe("Paste");
  });

  it("keeps a libraryRef snippet SHARED (no duplication) across profiles", () => {
    const snippet: SnippetLibraryItem = {
      id: "snip-1",
      name: "Greeting",
      text: "Hello",
      pasteMode: "sendText",
      tags: [],
    };
    const action = {
      id: "action-1",
      type: "textSnippet",
      payload: { source: "libraryRef", snippetId: "snip-1" },
      displayName: "Greeting",
    } as Action;
    const config = minimalConfig({
      bindings: [binding({ actionId: "action-1" })],
      actions: [action],
      snippetLibrary: [snippet],
    });

    const out = copyBindingBetweenProfiles(config, "binding-1", "code", "standard", "thumb_03" as ControlId);

    // Library global → the copy points at the SAME snippet, not a duplicate.
    expect(out.snippetLibrary).toHaveLength(1);
    const copied = out.actions.find((a) => a.id !== "action-1");
    expect(
      copied?.type === "textSnippet" && copied.payload.source === "libraryRef"
        ? copied.payload.snippetId
        : null,
    ).toBe("snip-1");
  });
});
