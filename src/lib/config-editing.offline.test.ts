import { describe, expect, it } from "vitest";
import { type Binding, type ShortcutActionPayload } from "./config";
import { copyBindingFromLayer, duplicateProfile, extractProfileExport, importProfile, isValidProfileExport, makeActionId, makeBindingId, setOfflineAssignment } from "./config-editing";
import { makeAction, makeConfig } from "./test-fixtures";

const shortcut: ShortcutActionPayload = { key: "C", ctrl: true, shift: false, alt: false, win: false };

describe.each(["offline", "offlineHypershift"] as const)("setOfflineAssignment: %s", (layer) => {
  it("adds, replaces and removes an own press without changing the original config", () => {
    const config = makeConfig();
    const added = setOfflineAssignment(config, "p1", "thumb_01", layer, shortcut);
    expect(config.bindings).toEqual([]);
    expect(config.actions).toEqual([]);
    expect(added.bindings).toMatchObject([{ profileId: "p1", controlId: "thumb_01", layer, enabled: true, triggerMode: "press" }]);
    expect(added.actions).toMatchObject([{ type: "shortcut", payload: shortcut }]);
    expect(added.encoderMappings).toEqual([]);
    const replaced = setOfflineAssignment(added, "p1", "thumb_01", layer, { action: "middleClick" });
    expect(replaced.bindings).toHaveLength(1);
    expect(replaced.actions).toMatchObject([{ type: "mouseAction", payload: { action: "middleClick" } }]);
    const silent = setOfflineAssignment(replaced, "p1", "thumb_01", layer, "silent");
    expect(silent.actions).toMatchObject([{ type: "disabled", payload: {} }]);
    const removed = setOfflineAssignment(silent, "p1", "thumb_01", layer, null);
    expect(removed.bindings).toEqual([]);
    expect(removed.actions).toEqual([]);
    expect(setOfflineAssignment(config, "p1", "thumb_01", layer, null)).toBe(config);
  });

  it("preserves actions used by other bindings or unbound menus", () => {
    const own = setOfflineAssignment(makeConfig(), "p1", "thumb_01", layer, shortcut);
    const actionId = own.bindings[0].actionId;
    const live: Binding = { ...own.bindings[0], id: "live", layer: "standard" };
    const shared = { ...own, bindings: [...own.bindings, live] };
    const replaced = setOfflineAssignment(shared, "p1", "thumb_01", layer, "silent");
    expect(replaced.actions.find((action) => action.id === actionId)).toMatchObject({ type: "shortcut", payload: shortcut });
    expect(replaced.bindings.find((binding) => binding.id === "live")).toEqual(live);
    const menu = makeAction({ id: "menu", type: "menu", payload: { items: [{ kind: "action", id: "item", label: "Copy", actionId, enabled: true }] } });
    const removed = setOfflineAssignment({ ...own, actions: [...own.actions, menu] }, "p1", "thumb_01", layer, null);
    expect(removed.actions).toEqual([...own.actions, menu]);
  });

  it("avoids colliding ids and leaves other profiles, controls and layers unchanged", () => {
    const action = makeAction({ id: makeActionId("p1", layer, "thumb_01"), type: "shortcut", payload: shortcut });
    const other: Binding = { id: makeBindingId("p1", layer, "thumb_01"), profileId: "p2", layer, controlId: "mouse_4", actionId: action.id, enabled: true, label: "Other" };
    const config = makeConfig({ actions: [action], bindings: [other] });
    const next = setOfflineAssignment(config, "p1", "thumb_01", layer, "silent");
    expect(next.bindings[0]).toEqual(other);
    expect(next.actions[0]).toEqual(action);
    expect(new Set(next.bindings.map((binding) => binding.id)).size).toBe(2);
    expect(new Set(next.actions.map((entry) => entry.id)).size).toBe(2);
  });

  it("carries offline assignments through profile duplication and export/import", () => {
    const config = setOfflineAssignment(makeConfig(), "p1", "thumb_01", layer, shortcut);
    const duplicate = duplicateProfile(config, "p1");
    expect(duplicate.config.bindings.find((binding) => binding.profileId === duplicate.newProfileId)).toMatchObject({ layer, controlId: "thumb_01" });
    const exported = extractProfileExport(config, "p1", { withoutTexts: true });
    expect(isValidProfileExport(exported)).toBe(true);
    expect(exported.bindings).toEqual(config.bindings);
    const imported = importProfile(config, exported);
    expect(imported.bindings).toHaveLength(2);
    expect(imported.bindings[1]).toMatchObject({ layer, controlId: "thumb_01" });
    expect(imported.bindings[1].profileId).not.toBe("p1");
    expect(imported.bindings[1].actionId).not.toBe(config.bindings[0].actionId);
  });

  it("does not copy a live layer into an offline layer", () => {
    const config = setOfflineAssignment(makeConfig(), "p1", "thumb_01", "offline", shortcut);
    config.bindings[0] = { ...config.bindings[0], layer: "standard" };
    expect(copyBindingFromLayer(config, "p1", "thumb_01", "standard", layer)).toBe(config);
  });
});
