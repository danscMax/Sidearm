import { describe, expect, it } from "vitest";
import type { Action, AppConfig, Binding, MenuItem, SnippetLibraryItem } from "./config";
import {
  applyBindingImport, buildBindingExport, extractProfileExport, importProfile,
  isValidBindingExport, isValidProfileExport, isValidSnippetLibraryExport,
  makeBindingId, mergeSnippetLibrary, removeBinding, removeBindingsForControls,
} from "./config-editing";
import { applyDeviceTransfer, planDeviceTransfer, retargetImportedBindings } from "./device-transfer";
import { NAGA_V3_DEVICE_ID } from "./devices";
import { makeConfig } from "./test-fixtures";
import { validConfigPart } from "./import-validation";

const shortcut: Action = { id: "a-key", displayName: "Copy", type: "shortcut", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } };
const snippet: SnippetLibraryItem = { id: "s-hi", name: "Hi", text: "Hello", pasteMode: "sendText", tags: [] };
const bind = (id: string, actionId: string, extra: Partial<Binding> = {}): Binding => ({
  id, actionId, profileId: "p1", layer: "standard", controlId: "thumb_01", label: id, enabled: true, ...extra,
});
const menu = (id: string, target: string): Action => ({ id, displayName: id, type: "menu", payload: {
  items: [{ kind: "action", id: "item", label: "Item", actionId: target, enabled: true }],
} });
const exported = () => extractProfileExport(makeConfig({ actions: [shortcut], bindings: [bind("b1", shortcut.id)] }), "p1");

function expectMenuReferencesResolve(config: AppConfig) {
  const check = (items: MenuItem[]) => {
    for (const item of items) {
      if (item.kind === "submenu") check(item.items);
      else expect(config.actions.some((action) => action.id === item.actionId)).toBe(true);
    }
  };
  for (const action of config.actions) if (action.type === "menu") check(action.payload.items);
}

describe("import boundary validation", () => {
  it.each([
    { type: "textSnippet", payload: { source: "inline", text: "Hi", pasteMode: "sendText", tags: [] } },
    { type: "sequence", payload: { steps: [{ type: "send", value: "Ctrl+C", repeat: 2 }, { type: "sleep", delayMs: 80 }] } },
    { type: "launch", payload: { target: "app.exe", args: ["--flag"], workingDir: "C:/Apps" } },
    { type: "mediaKey", payload: { key: "playPause" } },
    { type: "profileSwitch", payload: { targetProfileId: "p1" } },
    { type: "disabled", payload: {} },
    { type: "repairClipboard", payload: { strategy: "latin1" } },
  ])("accepts schema-valid payloads for $type", (entry) => {
    expect(isValidProfileExport({ ...exported(), actions: [{ ...shortcut, ...entry }] })).toBe(true);
  });

  it("accepts nested submenus and rejects excessive nesting without throwing", () => {
    const nested = (depth: number): Action => {
      let items: import("./config").MenuItem[] = [{ kind: "action", id: "leaf", label: "Leaf", actionId: shortcut.id, enabled: true }];
      for (let i = 0; i < depth; i++) items = [{ kind: "submenu", id: `level-${i}`, label: "Level", enabled: true, items }];
      return { id: "nested", displayName: "Nested", type: "menu", payload: { items } };
    };
    expect(isValidProfileExport({ ...exported(), actions: [shortcut, nested(16)] })).toBe(true);
    expect(isValidProfileExport({ ...exported(), actions: [shortcut, nested(1000)] })).toBe(false);
  });
  it.each([
    { ...shortcut, payload: { ...shortcut.payload, key: 42 } },
    { ...shortcut, payload: { key: "C", ctrl: true } },
    { ...shortcut, conditions: [{ type: "invalid", value: "x" }] },
    { ...shortcut, type: "sequence", payload: { steps: [null] } },
    { ...shortcut, type: "sequence", payload: { steps: [{ type: "sleep", delayMs: -1 }] } },
    { ...shortcut, type: "menu", payload: { items: [{ kind: "submenu", items: [null] }] } },
    { ...shortcut, type: "mouseAction", payload: { action: "invalid" } },
  ])("rejects malformed nested actions before import: %j", (action) => {
    const data = exported();
    expect(isValidProfileExport({ ...data, actions: [action] })).toBe(false);
    const bindingData = buildBindingExport(makeConfig({ actions: [shortcut], bindings: [bind("b1", shortcut.id)] }), "b1")!;
    expect(isValidBindingExport({ ...bindingData, action })).toBe(false);
  });

  it.each([{ ...snippet, pasteMode: "type" }, { ...snippet, tags: "tag" }, { ...snippet, tags: [42] }, { ...snippet, notes: 7 }])(
    "rejects malformed snippets in every envelope: %j", (entry) => {
      expect(isValidSnippetLibraryExport({ snippets: [entry] })).toBe(false);
      expect(isValidProfileExport({ ...exported(), snippetLibrary: [entry] })).toBe(false);
      const data = buildBindingExport(makeConfig({ actions: [shortcut], bindings: [bind("b1", shortcut.id)] }), "b1")!;
      expect(isValidBindingExport({ ...data, referencedSnippets: [entry] })).toBe(false);
    });

  it("rejects malformed bindings, mappings, duplicate ids and missing action references", () => {
    const data = exported();
    expect(isValidProfileExport({ ...data, bindings: [null] })).toBe(false);
    expect(isValidProfileExport({ ...data, bindings: [{ ...data.bindings[0], triggerMode: "invalid" }] })).toBe(false);
    expect(isValidProfileExport({ ...data, appMappings: [null] })).toBe(false);
    expect(isValidProfileExport({ ...data, encoderMappings: [{ controlId: "thumb_01", layer: "invalid" }] })).toBe(false);
    expect(isValidProfileExport({ ...data, actions: [shortcut, shortcut] })).toBe(false);
    expect(isValidProfileExport({ ...data, actions: [] })).toBe(false);
  });

  it("accepts generated exports and rejects dangling snippet/menu references", () => {
    expect(isValidProfileExport(exported())).toBe(true);
    expect(isValidSnippetLibraryExport({ snippets: [snippet] })).toBe(true);
    expect(isValidProfileExport({ ...exported(), actions: [{ ...shortcut, type: "textSnippet", payload: { source: "libraryRef", snippetId: "missing" } }] })).toBe(false);
    expect(isValidProfileExport({ ...exported(), actions: [menu(shortcut.id, "missing")] })).toBe(false);
  });

  it.each(["encoder mappings", "binding tuples", "remapped binding tuples"])("rejects duplicate %s before publishing a draft", (kind) => {
    const data = exported();
    if (kind === "encoder mappings") {
      data.encoderMappings = ["F13", "F14"].map((encodedKey) => ({ controlId: "thumb_01", layer: "standard", encodedKey, source: "synapse", verified: true }));
    } else {
      data.bindings.push({ ...data.bindings[0], id: "duplicate", triggerMode: "hold",
        profileId: kind === "remapped binding tuples" ? "other-source-profile" : data.profile.id });
    }
    const config = makeConfig();
    const before = structuredClone(config);
    let draft = config;
    expect(() => { draft = importProfile(draft, data); }).toThrow();
    expect(draft).toBe(config);
    expect(config).toEqual(before);
    expect(isValidProfileExport(data)).toBe(false);
  });

  it("rejects a profile switch to a missing profile before publishing a draft", () => {
    const data = { ...exported(), actions: [{ ...shortcut, type: "profileSwitch" as const, payload: { targetProfileId: "absent" } }] };
    const config = makeConfig();
    const before = structuredClone(config);
    let draft = config;
    expect(() => { draft = importProfile(draft, data); }).toThrow();
    expect(draft).toBe(config);
    expect(config).toEqual(before);
  });

  it.each(["p1", "p2"])("resolves imported profile switches to %s after id remapping", (targetProfileId) => {
    const data = { ...exported(), actions: [{ ...shortcut, type: "profileSwitch" as const, payload: { targetProfileId } }] };
    const config = makeConfig();
    const next = importProfile(config, data);
    const action = next.actions[0];
    const importedId = next.profiles.at(-1)!.id;
    expect(importedId).not.toBe("p1");
    expect(action.type === "profileSwitch" && action.payload.targetProfileId).toBe(targetProfileId === "p1" ? importedId : "p2");
    expect(config.actions).toEqual([]);
  });

  it("imports distinct press patterns on the same control", () => {
    const data = exported();
    data.bindings.push({ ...data.bindings[0], id: "long", triggerMode: "longPress" });
    expect(isValidProfileExport(data)).toBe(true);
    expect(importProfile(makeConfig(), data).bindings).toHaveLength(2);
  });

  it.each(["absent", "p2"])("validates a single-binding profile switch to %s against the destination", (targetProfileId) => {
    const source = makeConfig({ actions: [{ ...shortcut, type: "profileSwitch", payload: { targetProfileId } }], bindings: [bind("b1", shortcut.id)] });
    const data = buildBindingExport(source, "b1")!;
    const config = makeConfig();
    let draft = config;
    const apply = () => { draft = applyBindingImport(draft, data, "p1", "standard", "thumb_01"); };
    if (targetProfileId === "absent") {
      expect(apply).toThrow();
      expect(draft).toBe(config);
    } else {
      apply();
      expect(draft.actions[0]).toMatchObject({ type: "profileSwitch", payload: { targetProfileId: "p2" } });
    }
    expect(config.actions).toEqual([]);
  });
});

describe("binding identity and menu reachability", () => {
  it("imports a long press beside an existing press with a unique binding id", () => {
    const id = makeBindingId("p1", "standard", "thumb_01");
    const config = makeConfig({ actions: [shortcut], bindings: [bind(id, shortcut.id)] });
    const data = buildBindingExport(config, id)!;
    data.binding.triggerMode = "longPress";
    const next = applyBindingImport(config, data, "p1", "standard", "thumb_01");
    expect(next.bindings).toHaveLength(2);
    expect(new Set(next.bindings.map((b) => b.id)).size).toBe(2);
  });

  it("keeps a transitive menu target after single and bulk assignment removal", () => {
    const config = makeConfig({ actions: [shortcut, menu("menu-a", "menu-b"), menu("menu-b", shortcut.id)],
      bindings: [bind("direct", shortcut.id), bind("menu", "menu-a", { controlId: "mouse_4" })] });
    expect(removeBinding(config, "direct").actions).toContainEqual(shortcut);
    expect(removeBindingsForControls(config, "p1", "standard", new Set(["thumb_01"])).config.actions).toContainEqual(shortcut);
  });

  it.each([false, true])("keeps menu references valid after removing A→B→X then the direct X binding (bulk=%s)", (bulk) => {
    const config = makeConfig({ actions: [menu("menu-a", "menu-b"), menu("menu-b", shortcut.id), shortcut],
      bindings: [bind("menu", "menu-a", { controlId: "mouse_4" }), bind("direct", shortcut.id)] });
    const withoutMenuBinding = removeBinding(config, "menu");
    expectMenuReferencesResolve(withoutMenuBinding);
    const next = bulk ? removeBindingsForControls(withoutMenuBinding, "p1", "standard", new Set(["thumb_01"])).config
      : removeBinding(withoutMenuBinding, "direct");
    expect(next.bindings).toEqual([]);
    expectMenuReferencesResolve(next);
  });

  it("keeps a replaced action used by another button's menu, and rescues orphaned text", () => {
    const config = makeConfig({ actions: [shortcut, menu("menu-a", "old"),
      { id: "old", displayName: "Old text", type: "textSnippet", payload: { source: "inline", text: "Keep me", pasteMode: "sendText", tags: [] } }],
      bindings: [bind("src", shortcut.id), bind("target", "old", { controlId: "v3_thumb_01" }), bind("menu", "menu-a", { controlId: "mouse_4" })] });
    config.devices.push({ id: NAGA_V3_DEVICE_ID, name: "V3", builtin: true });
    config.physicalControls.push({ ...config.physicalControls[1], id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID });
    const transfer = (c: typeof config) => applyDeviceTransfer(c, "razer-naga", NAGA_V3_DEVICE_ID, planDeviceTransfer(c, "razer-naga", NAGA_V3_DEVICE_ID, ["p1"], "replace"));
    const linked = transfer(config);
    expect(linked.actions.some((a) => a.id === "old")).toBe(true);
    expectMenuReferencesResolve(linked);
    const unboundMenu = transfer({ ...config, bindings: config.bindings.filter((b) => b.id !== "menu") });
    expectMenuReferencesResolve(unboundMenu);
    expect(unboundMenu.actions.some((a) => a.id === "old") || unboundMenu.snippetLibrary.some((s) => s.text === "Keep me")).toBe(true);
    const orphan = transfer({ ...config, actions: config.actions.filter((a) => a.id !== "menu-a"), bindings: config.bindings.filter((b) => b.id !== "menu") });
    expect(orphan.snippetLibrary.map((s) => s.text)).toContain("Keep me");
    expectMenuReferencesResolve(orphan);
  });

  it("round-trips linked menus with library text and terminates on menu cycles", () => {
    const text: Action = { id: "text", displayName: "Hi", type: "textSnippet", payload: { source: "libraryRef", snippetId: snippet.id } };
    const config = makeConfig({ actions: [menu("menu-a", "menu-b"), menu("menu-b", text.id), text],
      bindings: [bind("b1", "menu-a")], snippetLibrary: [snippet] });
    const data = extractProfileExport(config, "p1");
    expect(data.actions).toHaveLength(3);
    expect(data.snippetLibrary).toEqual([snippet]);
    const imported = importProfile(makeConfig(), data);
    expect(imported.actions).toHaveLength(3);
    expect(isValidProfileExport(data)).toBe(true);
    const cycle = extractProfileExport({ ...config, actions: [menu("menu-a", "menu-b"), menu("menu-b", "menu-a")] }, "p1");
    expect(cycle.actions).toHaveLength(2);
    expect(isValidProfileExport(cycle)).toBe(true);
    const importedCycle = importProfile(makeConfig(), cycle);
    for (const action of importedCycle.actions) {
      expect(action.type === "menu" && action.payload.items.every((item) => item.kind === "action"
        && importedCycle.actions.some((target) => target.id === item.actionId))).toBe(true);
    }
  });
});

describe("profile retargeting and snippet batches", () => {
  it("imports V3 assignments onto a V2 using only the V2's encoder mappings", () => {
    const source = makeConfig({ bindings: [bind("b1", shortcut.id, { controlId: "v3_thumb_01" })], actions: [shortcut],
      devices: [{ id: NAGA_V3_DEVICE_ID, name: "V3", builtin: true }],
      physicalControls: [{ id: "v3_thumb_01", deviceId: NAGA_V3_DEVICE_ID, family: "thumbGrid", defaultName: "Thumb 1", remappable: true, capabilityStatus: "verified" }],
      encoderMappings: [{ controlId: "v3_thumb_01", layer: "standard", encodedKey: "F24", source: "synapse", verified: true }] });
    const target = makeConfig({ encoderMappings: [{ controlId: "thumb_01", layer: "standard", encodedKey: "F13", source: "synapse", verified: true }] });
    const imported = importProfile(target, extractProfileExport(source, "p1"));
    const next = retargetImportedBindings(imported, new Set(imported.bindings.map((b) => b.id)), "razer-naga").config;
    expect(next.bindings[0].controlId).toBe("thumb_01");
    expect(next.encoderMappings).toEqual(target.encoderMappings);
    expect(next.encoderMappings.every((m) => next.physicalControls.some((c) => c.id === m.controlId))).toBe(true);
    for (const [entries, definition] of [[next.profiles, "profile"], [next.actions, "action"],
      [next.bindings, "binding"], [next.encoderMappings, "encoderMapping"]] as const) {
      expect(entries.every((entry) => validConfigPart(definition, entry))).toBe(true);
    }
    expect(next.bindings.every((b) => next.profiles.some((p) => p.id === b.profileId)
      && next.actions.some((a) => a.id === b.actionId))).toBe(true);
  });

  it.each([false, true])("merges repeated new snippet ids in one batch (different=%s)", (different) => {
    const second = { ...snippet, text: different ? "Different" : snippet.text };
    const next = mergeSnippetLibrary(makeConfig(), [snippet, second]);
    expect(next.snippetLibrary).toHaveLength(different ? 2 : 1);
    expect(new Set(next.snippetLibrary.map((s) => s.id)).size).toBe(next.snippetLibrary.length);
    expect(next.snippetLibrary.map((s) => s.text)).toContain(second.text);
  });
});
