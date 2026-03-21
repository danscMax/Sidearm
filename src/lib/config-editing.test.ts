import { describe, it, expect } from "vitest";
import type {
  Action,
  ActionCondition,
  AppConfig,
  AppMapping,
  Binding,
  CapabilityStatus,
  ControlId,
  EncoderMapping,
  Layer,
  MenuItem,
  PhysicalControl,
  Profile,
  SnippetLibraryItem,
} from "./config";
import {
  findBinding,
  upsertBinding,
  upsertAction,
  upsertProfile,
  upsertPhysicalControl,
  upsertAppMapping,
  upsertSnippetLibraryItem,
  upsertEncoderMapping,
  coerceActionType,
  promoteInlineSnippetActionToLibrary,
  createAppMappingFromCapture,
  ensurePlaceholderBinding,
  seedExpectedEncoderMapping,
  updateControlCapabilityStatus,
  createProfile,
  deleteProfile,
  duplicateBinding,
  copyBindingFromLayer,
  removeBinding,
  expectedEncodedKeyForControl,
  makeBindingId,
  makeActionId,
  makeProfileId,
  makeSnippetId,
  makeAppMappingId,
  extractProfileExport,
  mergeImportedProfile,
} from "./config-editing";
import type { ProfileExportData } from "./config-editing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMinimalConfig(): AppConfig {
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
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "profile-default",
    name: "Default",
    enabled: true,
    priority: 10,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<Binding> = {}): Binding {
  return {
    id: "binding-1",
    profileId: "profile-default",
    layer: "standard" as Layer,
    controlId: "thumb_01" as ControlId,
    label: "Test Binding",
    actionRef: "action-1",
    enabled: true,
    ...overrides,
  };
}

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "action-1",
    type: "shortcut",
    payload: { key: "A", ctrl: false, shift: false, alt: false, win: false },
    pretty: "Test Action",
    ...overrides,
  } as Action;
}

function makePhysicalControl(overrides: Partial<PhysicalControl> = {}): PhysicalControl {
  return {
    id: "thumb_01" as ControlId,
    family: "thumbGrid",
    defaultName: "Thumb 1",
    remappable: true,
    capabilityStatus: "verified" as CapabilityStatus,
    ...overrides,
  };
}

function makeEncoderMapping(overrides: Partial<EncoderMapping> = {}): EncoderMapping {
  return {
    controlId: "thumb_01" as ControlId,
    layer: "standard" as Layer,
    encodedKey: "F13",
    source: "synapse",
    verified: false,
    ...overrides,
  };
}

function makeAppMapping(overrides: Partial<AppMapping> = {}): AppMapping {
  return {
    id: "app-chrome",
    exe: "chrome.exe",
    profileId: "profile-default",
    enabled: true,
    priority: 10,
    ...overrides,
  };
}

function makeSnippetLibraryItem(overrides: Partial<SnippetLibraryItem> = {}): SnippetLibraryItem {
  return {
    id: "snippet-hello",
    name: "Hello",
    text: "Hello, world!",
    pasteMode: "clipboardPaste",
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findBinding
// ---------------------------------------------------------------------------

describe("findBinding", () => {
  it("returns the binding when profileId, layer, and controlId match", () => {
    const binding = makeBinding();
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = findBinding(config, "profile-default", "standard", "thumb_01");
    expect(result).toEqual(binding);
  });

  it("returns null when no binding matches", () => {
    const config = createMinimalConfig();
    const result = findBinding(config, "profile-default", "standard", "thumb_01");
    expect(result).toBeNull();
  });

  it("returns null when profileId does not match", () => {
    const binding = makeBinding();
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = findBinding(config, "profile-other", "standard", "thumb_01");
    expect(result).toBeNull();
  });

  it("returns null when layer does not match", () => {
    const binding = makeBinding();
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = findBinding(config, "profile-default", "hypershift", "thumb_01");
    expect(result).toBeNull();
  });

  it("returns null when controlId does not match", () => {
    const binding = makeBinding();
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = findBinding(config, "profile-default", "standard", "thumb_02");
    expect(result).toBeNull();
  });

  it("returns the first matching binding when multiple bindings exist", () => {
    const b1 = makeBinding({ id: "b1", controlId: "thumb_01" });
    const b2 = makeBinding({ id: "b2", controlId: "thumb_02" });
    const config = { ...createMinimalConfig(), bindings: [b1, b2] };

    const result = findBinding(config, "profile-default", "standard", "thumb_02");
    expect(result).toEqual(b2);
  });
});

// ---------------------------------------------------------------------------
// upsertBinding
// ---------------------------------------------------------------------------

describe("upsertBinding", () => {
  it("inserts a new binding when no matching id exists", () => {
    const config = createMinimalConfig();
    const binding = makeBinding();

    const result = upsertBinding(config, binding);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toEqual(binding);
  });

  it("updates an existing binding matched by id", () => {
    const binding = makeBinding();
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const updated = { ...binding, label: "Updated Label" };
    const result = upsertBinding(config, updated);

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.label).toBe("Updated Label");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    const binding = makeBinding();

    upsertBinding(config, binding);
    expect(config.bindings).toHaveLength(0);
  });

  it("preserves other bindings when inserting", () => {
    const existing = makeBinding({ id: "existing" });
    const config = { ...createMinimalConfig(), bindings: [existing] };
    const newBinding = makeBinding({ id: "new" });

    const result = upsertBinding(config, newBinding);
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings[0]).toEqual(existing);
    expect(result.bindings[1]).toEqual(newBinding);
  });
});

// ---------------------------------------------------------------------------
// upsertAction
// ---------------------------------------------------------------------------

describe("upsertAction", () => {
  it("inserts a new action when no matching id exists", () => {
    const config = createMinimalConfig();
    const action = makeAction();

    const result = upsertAction(config, action);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual(action);
  });

  it("updates an existing action matched by id", () => {
    const action = makeAction();
    const config = { ...createMinimalConfig(), actions: [action] };

    const updated = { ...action, pretty: "Updated Pretty" } as Action;
    const result = upsertAction(config, updated);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.pretty).toBe("Updated Pretty");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertAction(config, makeAction());
    expect(config.actions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertProfile
// ---------------------------------------------------------------------------

describe("upsertProfile", () => {
  it("inserts a new profile when no matching id exists", () => {
    const config = createMinimalConfig();
    const profile = makeProfile();

    const result = upsertProfile(config, profile);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toEqual(profile);
  });

  it("updates an existing profile matched by id", () => {
    const profile = makeProfile();
    const config = { ...createMinimalConfig(), profiles: [profile] };

    const updated = { ...profile, name: "Renamed" };
    const result = upsertProfile(config, updated);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.name).toBe("Renamed");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertProfile(config, makeProfile());
    expect(config.profiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertPhysicalControl
// ---------------------------------------------------------------------------

describe("upsertPhysicalControl", () => {
  it("inserts a new physical control when no matching id exists", () => {
    const config = createMinimalConfig();
    const control = makePhysicalControl();

    const result = upsertPhysicalControl(config, control);
    expect(result.physicalControls).toHaveLength(1);
    expect(result.physicalControls[0]).toEqual(control);
  });

  it("updates an existing physical control matched by id", () => {
    const control = makePhysicalControl();
    const config = { ...createMinimalConfig(), physicalControls: [control] };

    const updated = { ...control, defaultName: "Updated" };
    const result = upsertPhysicalControl(config, updated);

    expect(result.physicalControls).toHaveLength(1);
    expect(result.physicalControls[0]!.defaultName).toBe("Updated");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertPhysicalControl(config, makePhysicalControl());
    expect(config.physicalControls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertAppMapping
// ---------------------------------------------------------------------------

describe("upsertAppMapping", () => {
  it("inserts a new app mapping when no matching id exists", () => {
    const config = createMinimalConfig();
    const mapping = makeAppMapping();

    const result = upsertAppMapping(config, mapping);
    expect(result.appMappings).toHaveLength(1);
    expect(result.appMappings[0]).toEqual(mapping);
  });

  it("updates an existing app mapping matched by id", () => {
    const mapping = makeAppMapping();
    const config = { ...createMinimalConfig(), appMappings: [mapping] };

    const updated = { ...mapping, exe: "firefox.exe" };
    const result = upsertAppMapping(config, updated);

    expect(result.appMappings).toHaveLength(1);
    expect(result.appMappings[0]!.exe).toBe("firefox.exe");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertAppMapping(config, makeAppMapping());
    expect(config.appMappings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertSnippetLibraryItem
// ---------------------------------------------------------------------------

describe("upsertSnippetLibraryItem", () => {
  it("inserts a new snippet when no matching id exists", () => {
    const config = createMinimalConfig();
    const snippet = makeSnippetLibraryItem();

    const result = upsertSnippetLibraryItem(config, snippet);
    expect(result.snippetLibrary).toHaveLength(1);
    expect(result.snippetLibrary[0]).toEqual(snippet);
  });

  it("updates an existing snippet matched by id", () => {
    const snippet = makeSnippetLibraryItem();
    const config = { ...createMinimalConfig(), snippetLibrary: [snippet] };

    const updated = { ...snippet, text: "Updated text" };
    const result = upsertSnippetLibraryItem(config, updated);

    expect(result.snippetLibrary).toHaveLength(1);
    expect(result.snippetLibrary[0]!.text).toBe("Updated text");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertSnippetLibraryItem(config, makeSnippetLibraryItem());
    expect(config.snippetLibrary).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertEncoderMapping
// ---------------------------------------------------------------------------

describe("upsertEncoderMapping", () => {
  it("inserts a new encoder mapping when no matching controlId+layer exists", () => {
    const config = createMinimalConfig();
    const mapping = makeEncoderMapping();

    const result = upsertEncoderMapping(config, mapping);
    expect(result.encoderMappings).toHaveLength(1);
    expect(result.encoderMappings[0]).toEqual(mapping);
  });

  it("updates an existing encoder mapping matched by controlId AND layer", () => {
    const mapping = makeEncoderMapping();
    const config = { ...createMinimalConfig(), encoderMappings: [mapping] };

    const updated = { ...mapping, encodedKey: "F24", verified: true };
    const result = upsertEncoderMapping(config, updated);

    expect(result.encoderMappings).toHaveLength(1);
    expect(result.encoderMappings[0]!.encodedKey).toBe("F24");
    expect(result.encoderMappings[0]!.verified).toBe(true);
  });

  it("inserts when controlId matches but layer differs", () => {
    const existing = makeEncoderMapping({ layer: "standard" });
    const config = { ...createMinimalConfig(), encoderMappings: [existing] };

    const newMapping = makeEncoderMapping({ layer: "hypershift", encodedKey: "Ctrl+Alt+Shift+F13" });
    const result = upsertEncoderMapping(config, newMapping);

    expect(result.encoderMappings).toHaveLength(2);
  });

  it("inserts when layer matches but controlId differs", () => {
    const existing = makeEncoderMapping({ controlId: "thumb_01" });
    const config = { ...createMinimalConfig(), encoderMappings: [existing] };

    const newMapping = makeEncoderMapping({ controlId: "thumb_02", encodedKey: "F14" });
    const result = upsertEncoderMapping(config, newMapping);

    expect(result.encoderMappings).toHaveLength(2);
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    upsertEncoderMapping(config, makeEncoderMapping());
    expect(config.encoderMappings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// coerceActionType
// ---------------------------------------------------------------------------

describe("coerceActionType", () => {
  function configWithAction(action: Action): AppConfig {
    return { ...createMinimalConfig(), actions: [action] };
  }

  it("returns config unchanged when action id not found", () => {
    const config = createMinimalConfig();
    const result = coerceActionType(config, "nonexistent", "shortcut");
    expect(result).toBe(config);
  });

  it("returns config unchanged when action already has the target type", () => {
    const action = makeAction({ type: "shortcut" });
    const config = configWithAction(action);

    const result = coerceActionType(config, action.id, "shortcut");
    expect(result).toBe(config);
  });

  it("coerces to shortcut", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "shortcut");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("shortcut");
    if (coerced?.type === "shortcut") {
      expect(coerced.payload.key).toBe("A");
      expect(coerced.payload.ctrl).toBe(false);
    }
  });

  it("coerces to textSnippet", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "textSnippet");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("textSnippet");
    if (coerced?.type === "textSnippet") {
      expect(coerced.payload.source).toBe("inline");
    }
  });

  it("coerces to sequence", () => {
    const action = makeAction({
      id: "a",
      type: "disabled",
      payload: {} as Record<string, never>,
      pretty: "My Step",
    });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "sequence");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("sequence");
    if (coerced?.type === "sequence") {
      expect(coerced.payload.steps).toHaveLength(1);
      expect(coerced.payload.steps[0]!.type).toBe("text");
      const step = coerced.payload.steps[0]!;
      expect(step.type === "text" && step.value).toBe("My Step");
    }
  });

  it("coerces to sequence with 'Replace me' when pretty is empty", () => {
    const action = makeAction({
      id: "a",
      type: "disabled",
      payload: {} as Record<string, never>,
      pretty: "   ",
    });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "sequence");
    const coerced = result.actions.find((a) => a.id === "a");
    if (coerced?.type === "sequence") {
      const step = coerced.payload.steps[0]!;
      expect(step.type === "text" && step.value).toBe("Replace me");
    }
  });

  it("coerces to launch", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "launch");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("launch");
    if (coerced?.type === "launch") {
      expect(coerced.payload.target).toContain("App.exe");
    }
  });

  it("coerces to menu and references an existing action", () => {
    const otherAction = makeAction({ id: "other", pretty: "Other Action" });
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = { ...createMinimalConfig(), actions: [action, otherAction] };

    const result = coerceActionType(config, "a", "menu");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("menu");
    if (coerced?.type === "menu") {
      expect(coerced.payload.items).toHaveLength(1);
      expect(coerced.payload.items[0]!.kind).toBe("action");
      if (coerced.payload.items[0]!.kind === "action") {
        expect(coerced.payload.items[0]!.actionRef).toBe("other");
      }
    }
  });

  it("coerces to menu and creates a placeholder action when no other action exists", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "menu");
    // Should have original action + placeholder
    expect(result.actions.length).toBeGreaterThanOrEqual(2);
    const placeholder = result.actions.find((a) => a.id !== "a");
    expect(placeholder).toBeDefined();
    expect(placeholder?.type).toBe("disabled");
    expect(placeholder?.id).toContain("action-menu-target");
  });

  it("coerces to mouseAction", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "mouseAction");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("mouseAction");
    if (coerced?.type === "mouseAction") {
      expect(coerced.payload.action).toBe("leftClick");
    }
  });

  it("coerces to mediaKey", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "mediaKey");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("mediaKey");
    if (coerced?.type === "mediaKey") {
      expect(coerced.payload.key).toBe("playPause");
    }
  });

  it("coerces to profileSwitch", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "profileSwitch");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("profileSwitch");
    if (coerced?.type === "profileSwitch") {
      expect(coerced.payload.targetProfileId).toBe("");
    }
  });

  it("coerces to profileSwitch using first available profile id", () => {
    const action = makeAction({ id: "a", type: "disabled", payload: {} as Record<string, never> });
    const profile = makeProfile({ id: "prof-gaming", name: "Gaming" });
    const config = {
      ...createMinimalConfig(),
      actions: [action],
      profiles: [profile],
    };

    const result = coerceActionType(config, "a", "profileSwitch");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("profileSwitch");
    if (coerced?.type === "profileSwitch") {
      expect(coerced.payload.targetProfileId).toBe("prof-gaming");
    }
  });

  it("coerces to disabled and preserves existing notes", () => {
    const action = makeAction({
      id: "a",
      type: "shortcut",
      notes: "User note",
    });
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "disabled");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("disabled");
    expect(coerced?.notes).toBe("User note");
  });

  it("coerces to disabled and adds placeholder note when no existing notes", () => {
    const action = makeAction({ id: "a", type: "shortcut" });
    // Ensure no notes property
    delete (action as { notes?: string }).notes;
    const config = configWithAction(action);

    const result = coerceActionType(config, "a", "disabled");
    const coerced = result.actions.find((a) => a.id === "a");
    expect(coerced?.type).toBe("disabled");
    expect(coerced?.notes).toContain("placeholder");
  });
});

// ---------------------------------------------------------------------------
// promoteInlineSnippetActionToLibrary
// ---------------------------------------------------------------------------

describe("promoteInlineSnippetActionToLibrary", () => {
  it("promotes an inline text snippet action to a library ref", () => {
    const action: Action = {
      id: "action-snippet",
      type: "textSnippet",
      payload: {
        source: "inline",
        text: "Hello world",
        pasteMode: "clipboardPaste",
        tags: ["greeting"],
      },
      pretty: "Hello Snippet",
    };
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "action-snippet", "My Snippet");
    expect(result.snippetLibrary).toHaveLength(1);
    expect(result.snippetLibrary[0]!.name).toBe("My Snippet");
    expect(result.snippetLibrary[0]!.text).toBe("Hello world");
    expect(result.snippetLibrary[0]!.pasteMode).toBe("clipboardPaste");
    expect(result.snippetLibrary[0]!.tags).toEqual(["greeting"]);

    const updatedAction = result.actions.find((a) => a.id === "action-snippet");
    expect(updatedAction?.type).toBe("textSnippet");
    if (updatedAction?.type === "textSnippet") {
      expect(updatedAction.payload.source).toBe("libraryRef");
      if (updatedAction.payload.source === "libraryRef") {
        expect(updatedAction.payload.snippetId).toBe(result.snippetLibrary[0]!.id);
      }
    }
  });

  it("returns config unchanged when action type is not textSnippet", () => {
    const action = makeAction({ id: "a", type: "shortcut" });
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "a", "Name");
    expect(result).toBe(config);
  });

  it("returns config unchanged when action is already a library ref", () => {
    const action: Action = {
      id: "action-ref",
      type: "textSnippet",
      payload: {
        source: "libraryRef",
        snippetId: "snippet-existing",
      },
      pretty: "Ref Snippet",
    };
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "action-ref", "Name");
    expect(result).toBe(config);
  });

  it("returns config unchanged when action id is not found", () => {
    const config = createMinimalConfig();
    const result = promoteInlineSnippetActionToLibrary(config, "nonexistent", "Name");
    expect(result).toBe(config);
  });

  it("uses action pretty as snippet name when preferred name is empty", () => {
    const action: Action = {
      id: "a",
      type: "textSnippet",
      payload: { source: "inline", text: "t", pasteMode: "clipboardPaste", tags: [] },
      pretty: "Action Name",
    };
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "a", "   ");
    expect(result.snippetLibrary[0]!.name).toBe("Action Name");
  });

  it("uses 'New snippet' when both preferred name and pretty are empty", () => {
    const action: Action = {
      id: "a",
      type: "textSnippet",
      payload: { source: "inline", text: "t", pasteMode: "clipboardPaste", tags: [] },
      pretty: "   ",
    };
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "a", "");
    expect(result.snippetLibrary[0]!.name).toBe("New snippet");
  });

  it("deduplicates tags from the inline snippet", () => {
    const action: Action = {
      id: "a",
      type: "textSnippet",
      payload: { source: "inline", text: "t", pasteMode: "clipboardPaste", tags: ["a", "b", "a", "c", "b"] },
      pretty: "Dups",
    };
    const config = { ...createMinimalConfig(), actions: [action] };

    const result = promoteInlineSnippetActionToLibrary(config, "a", "Tagged");
    expect(result.snippetLibrary[0]!.tags).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// createAppMappingFromCapture
// ---------------------------------------------------------------------------

describe("createAppMappingFromCapture", () => {
  it("creates an app mapping with normalized exe", () => {
    const config = createMinimalConfig();
    const { config: result, newMappingId } = createAppMappingFromCapture(config, "prof-1", 10, "  Chrome.EXE  ", "My Window", false);

    expect(result.appMappings).toHaveLength(1);
    expect(result.appMappings[0]!.exe).toBe("chrome.exe");
    expect(result.appMappings[0]!.profileId).toBe("prof-1");
    expect(result.appMappings[0]!.priority).toBe(10);
    expect(result.appMappings[0]!.enabled).toBe(true);
    expect(result.appMappings[0]!.titleIncludes).toBeUndefined();
    expect(newMappingId).toBe(result.appMappings[0]!.id);
  });

  it("includes title filter when includeTitleFilter is true", () => {
    const config = createMinimalConfig();
    const { config: result } = createAppMappingFromCapture(config, "prof-1", 10, "app.exe", "  Document Title  ", true);

    expect(result.appMappings[0]!.titleIncludes).toEqual(["Document Title"]);
  });

  it("omits title filter when title is blank even if includeTitleFilter is true", () => {
    const config = createMinimalConfig();
    const { config: result } = createAppMappingFromCapture(config, "prof-1", 10, "app.exe", "   ", true);

    expect(result.appMappings[0]!.titleIncludes).toBeUndefined();
  });

  it("generates unique ids when conflicts exist", () => {
    const existing = makeAppMapping({ id: "app-chrome" });
    const config = { ...createMinimalConfig(), appMappings: [existing] };

    const { config: result } = createAppMappingFromCapture(config, "prof-1", 10, "chrome.exe", "", false);

    expect(result.appMappings).toHaveLength(2);
    expect(result.appMappings[1]!.id).toBe("app-chrome-2");
  });
});

// ---------------------------------------------------------------------------
// ensurePlaceholderBinding
// ---------------------------------------------------------------------------

describe("ensurePlaceholderBinding", () => {
  const control = makePhysicalControl({ id: "thumb_01", defaultName: "Thumb 1" });

  it("returns config unchanged when binding already exists for the slot", () => {
    const binding = makeBinding({
      profileId: "prof",
      layer: "standard",
      controlId: "thumb_01",
    });
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = ensurePlaceholderBinding(config, "prof", "standard", control);
    expect(result).toBe(config);
  });

  it("creates both a new binding and action when neither exists", () => {
    const config = createMinimalConfig();

    const result = ensurePlaceholderBinding(config, "prof", "standard", control);
    expect(result.bindings).toHaveLength(1);
    expect(result.actions).toHaveLength(1);

    const binding = result.bindings[0]!;
    expect(binding.profileId).toBe("prof");
    expect(binding.layer).toBe("standard");
    expect(binding.controlId).toBe("thumb_01");
    expect(binding.enabled).toBe(false);
    expect(binding.label).toContain("Thumb 1");

    const action = result.actions[0]!;
    expect(action.type).toBe("disabled");
    expect(action.id).toBe(binding.actionRef);
  });

  it("reuses an existing action id if it matches the derived id", () => {
    const derivedActionId = makeActionId("prof", "standard", "thumb_01");
    const existingAction = makeAction({ id: derivedActionId, type: "shortcut" });
    const config = { ...createMinimalConfig(), actions: [existingAction] };

    const result = ensurePlaceholderBinding(config, "prof", "standard", control);

    // Should reuse the existing action, not create another
    expect(result.actions).toHaveLength(1);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.actionRef).toBe(derivedActionId);
  });
});

// ---------------------------------------------------------------------------
// seedExpectedEncoderMapping
// ---------------------------------------------------------------------------

describe("seedExpectedEncoderMapping", () => {
  it("creates a synapse-sourced mapping for a known thumb grid control", () => {
    const control = makePhysicalControl({ id: "thumb_01" });
    const config = createMinimalConfig();

    const result = seedExpectedEncoderMapping(config, "standard", control);
    expect(result.encoderMappings).toHaveLength(1);
    expect(result.encoderMappings[0]!.source).toBe("synapse");
    expect(result.encoderMappings[0]!.encodedKey).toBe("F13");
  });

  it("creates a detected placeholder mapping for an unknown control", () => {
    const control = makePhysicalControl({ id: "hypershift_button" as ControlId });
    const config = createMinimalConfig();

    const result = seedExpectedEncoderMapping(config, "standard", control);
    expect(result.encoderMappings).toHaveLength(1);
    expect(result.encoderMappings[0]!.source).toBe("detected");
    expect(result.encoderMappings[0]!.encodedKey).toContain("TODO");
  });

  it("creates a synapse mapping for top_aux_01 standard layer", () => {
    const control = makePhysicalControl({ id: "top_aux_01" as ControlId });
    const config = createMinimalConfig();

    const result = seedExpectedEncoderMapping(config, "standard", control);
    expect(result.encoderMappings[0]!.encodedKey).toBe("Ctrl+Shift+F23");
    expect(result.encoderMappings[0]!.source).toBe("synapse");
  });

  it("does not duplicate an existing mapping if ensureEncoderMapping path is taken", () => {
    const control = makePhysicalControl({ id: "hypershift_button" as ControlId });
    const existing = makeEncoderMapping({
      controlId: "hypershift_button" as ControlId,
      layer: "standard",
    });
    const config = { ...createMinimalConfig(), encoderMappings: [existing] };

    const result = seedExpectedEncoderMapping(config, "standard", control);
    expect(result.encoderMappings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateControlCapabilityStatus
// ---------------------------------------------------------------------------

describe("updateControlCapabilityStatus", () => {
  it("changes the capability status of a matching control", () => {
    const control = makePhysicalControl({ id: "thumb_01", capabilityStatus: "needsValidation" });
    const config = { ...createMinimalConfig(), physicalControls: [control] };

    const result = updateControlCapabilityStatus(config, "thumb_01", "verified");
    expect(result.physicalControls[0]!.capabilityStatus).toBe("verified");
  });

  it("returns config unchanged when status is already the same", () => {
    const control = makePhysicalControl({ id: "thumb_01", capabilityStatus: "verified" });
    const config = { ...createMinimalConfig(), physicalControls: [control] };

    const result = updateControlCapabilityStatus(config, "thumb_01", "verified");
    expect(result).toBe(config);
  });

  it("returns config unchanged when controlId is not found", () => {
    const config = createMinimalConfig();
    const result = updateControlCapabilityStatus(config, "thumb_01", "verified");
    expect(result).toBe(config);
  });

  it("does not mutate the original config", () => {
    const control = makePhysicalControl({ id: "thumb_01", capabilityStatus: "needsValidation" });
    const config = { ...createMinimalConfig(), physicalControls: [control] };

    updateControlCapabilityStatus(config, "thumb_01", "verified");
    expect(config.physicalControls[0]!.capabilityStatus).toBe("needsValidation");
  });
});

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

describe("createProfile", () => {
  it("creates a profile with a unique id and priority 10 in empty config", () => {
    const config = createMinimalConfig();
    const result = createProfile(config, "Gaming");

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.name).toBe("Gaming");
    expect(result.profiles[0]!.id).toBe("gaming");
    expect(result.profiles[0]!.enabled).toBe(true);
    expect(result.profiles[0]!.priority).toBe(10);
  });

  it("assigns priority = highestExisting + 10", () => {
    const existing = makeProfile({ priority: 25 });
    const config = { ...createMinimalConfig(), profiles: [existing] };

    const result = createProfile(config, "Second");
    expect(result.profiles[1]!.priority).toBe(35);
  });

  it("uses 'New Profile' when name is empty or whitespace", () => {
    const config = createMinimalConfig();
    const result = createProfile(config, "   ");

    expect(result.profiles[0]!.name).toBe("New Profile");
  });

  it("generates a unique id when name conflicts with existing profile", () => {
    const existing = makeProfile({ id: "gaming", name: "Gaming" });
    const config = { ...createMinimalConfig(), profiles: [existing] };

    const result = createProfile(config, "Gaming");
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[1]!.id).toBe("gaming-2");
    expect(result.profiles[1]!.name).toBe("Gaming");
  });

  it("generates sequential unique ids when multiple conflicts exist", () => {
    const p1 = makeProfile({ id: "gaming", name: "Gaming", priority: 10 });
    const p2 = makeProfile({ id: "gaming-2", name: "Gaming 2", priority: 20 });
    const config = { ...createMinimalConfig(), profiles: [p1, p2] };

    const result = createProfile(config, "Gaming");
    expect(result.profiles[2]!.id).toBe("gaming-3");
  });

  it("does not mutate the original config", () => {
    const config = createMinimalConfig();
    createProfile(config, "Test");
    expect(config.profiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

describe("deleteProfile", () => {
  it("removes the profile, its bindings, orphaned actions, and app mappings", () => {
    const profile = makeProfile({ id: "prof-1" });
    const binding = makeBinding({ id: "b1", profileId: "prof-1", actionRef: "a1" });
    const action = makeAction({ id: "a1" });
    const appMapping = makeAppMapping({ id: "am1", profileId: "prof-1" });
    const config = {
      ...createMinimalConfig(),
      profiles: [profile],
      bindings: [binding],
      actions: [action],
      appMappings: [appMapping],
    };

    const result = deleteProfile(config, "prof-1");
    expect(result.profiles).toHaveLength(0);
    expect(result.bindings).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
    expect(result.appMappings).toHaveLength(0);
  });

  it("preserves actions that are referenced by other profiles", () => {
    const p1 = makeProfile({ id: "prof-1" });
    const p2 = makeProfile({ id: "prof-2" });
    const sharedAction = makeAction({ id: "shared-action" });
    const b1 = makeBinding({ id: "b1", profileId: "prof-1", actionRef: "shared-action" });
    const b2 = makeBinding({
      id: "b2",
      profileId: "prof-2",
      controlId: "thumb_02",
      actionRef: "shared-action",
    });
    const config = {
      ...createMinimalConfig(),
      profiles: [p1, p2],
      bindings: [b1, b2],
      actions: [sharedAction],
    };

    const result = deleteProfile(config, "prof-1");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.id).toBe("shared-action");
  });

  it("preserves bindings and app mappings for other profiles", () => {
    const p1 = makeProfile({ id: "prof-1" });
    const p2 = makeProfile({ id: "prof-2" });
    const b1 = makeBinding({ id: "b1", profileId: "prof-1", actionRef: "a1" });
    const b2 = makeBinding({ id: "b2", profileId: "prof-2", actionRef: "a2" });
    const a1 = makeAction({ id: "a1" });
    const a2 = makeAction({ id: "a2" });
    const am1 = makeAppMapping({ id: "am1", profileId: "prof-1" });
    const am2 = makeAppMapping({ id: "am2", profileId: "prof-2" });
    const config = {
      ...createMinimalConfig(),
      profiles: [p1, p2],
      bindings: [b1, b2],
      actions: [a1, a2],
      appMappings: [am1, am2],
    };

    const result = deleteProfile(config, "prof-1");
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.id).toBe("prof-2");
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.id).toBe("b2");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.id).toBe("a2");
    expect(result.appMappings).toHaveLength(1);
    expect(result.appMappings[0]!.id).toBe("am2");
  });

  it("returns config unchanged when profile does not exist", () => {
    const config = createMinimalConfig();
    const result = deleteProfile(config, "nonexistent");
    expect(result.profiles).toHaveLength(0);
  });

  it("does not mutate the original config", () => {
    const profile = makeProfile({ id: "prof-1" });
    const config = { ...createMinimalConfig(), profiles: [profile] };

    deleteProfile(config, "prof-1");
    expect(config.profiles).toHaveLength(1);
  });

  it("handles cascading cleanup: multiple bindings, mixed action references", () => {
    const profile = makeProfile({ id: "prof-1" });
    const otherProfile = makeProfile({ id: "prof-2" });
    const orphanAction = makeAction({ id: "orphan" });
    const sharedAction = makeAction({ id: "shared" });
    const b1 = makeBinding({ id: "b1", profileId: "prof-1", controlId: "thumb_01", actionRef: "orphan" });
    const b2 = makeBinding({ id: "b2", profileId: "prof-1", controlId: "thumb_02", actionRef: "shared" });
    const b3 = makeBinding({ id: "b3", profileId: "prof-2", controlId: "thumb_03", actionRef: "shared" });
    const config = {
      ...createMinimalConfig(),
      profiles: [profile, otherProfile],
      bindings: [b1, b2, b3],
      actions: [orphanAction, sharedAction],
    };

    const result = deleteProfile(config, "prof-1");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.id).toBe("shared");
  });

  it("preserves actions referenced by menu items in surviving bindings", () => {
    const deletedProfile = makeProfile({ id: "prof-del" });
    const survivingProfile = makeProfile({ id: "prof-keep" });

    // Menu action with nested actionRefs
    const menuTargetAction = makeAction({ id: "menu-target-1", pretty: "Open Browser" });
    const menuTargetAction2 = makeAction({ id: "menu-target-2", pretty: "Open Editor" });
    const menuAction: Action = {
      id: "menu-action",
      type: "menu",
      payload: {
        items: [
          { kind: "action", id: "mi-1", label: "Browser", actionRef: "menu-target-1", enabled: true },
          { kind: "action", id: "mi-2", label: "Editor", actionRef: "menu-target-2", enabled: true },
        ],
      },
      pretty: "My Menu",
    };

    // Binding on deleted profile (should be removed)
    const deletedBinding = makeBinding({ id: "b-del", profileId: "prof-del", controlId: "thumb_01", actionRef: "orphan-action" });
    const orphanAction = makeAction({ id: "orphan-action", pretty: "Orphan" });

    // Binding on surviving profile referencing the menu
    const survivingBinding = makeBinding({ id: "b-keep", profileId: "prof-keep", controlId: "thumb_02", actionRef: "menu-action" });

    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [deletedProfile, survivingProfile],
      bindings: [deletedBinding, survivingBinding],
      actions: [menuAction, menuTargetAction, menuTargetAction2, orphanAction],
    };

    const result = deleteProfile(config, "prof-del");
    const actionIds = result.actions.map((a) => a.id).sort();

    // Menu action + its two targets should survive; orphan should be gone
    expect(actionIds).toEqual(["menu-action", "menu-target-1", "menu-target-2"]);
    expect(result.actions.find((a) => a.id === "orphan-action")).toBeUndefined();
  });

  it("preserves actions referenced by nested submenu items", () => {
    const profile = makeProfile({ id: "prof-keep" });

    const deepAction = makeAction({ id: "deep-action", pretty: "Deep" });
    const menuAction: Action = {
      id: "menu-action",
      type: "menu",
      payload: {
        items: [
          {
            kind: "submenu",
            id: "sub-1",
            label: "Sub",
            enabled: true,
            items: [
              { kind: "action", id: "mi-deep", label: "Deep Item", actionRef: "deep-action", enabled: true },
            ],
          } as MenuItem,
        ],
      },
      pretty: "Menu with submenu",
    };

    const binding = makeBinding({ id: "b1", profileId: "prof-keep", controlId: "thumb_01", actionRef: "menu-action" });

    // A second profile that we delete
    const deletedProfile = makeProfile({ id: "prof-del" });
    const deletedBinding = makeBinding({ id: "b-del", profileId: "prof-del", controlId: "thumb_02", actionRef: "some-action" });
    const someAction = makeAction({ id: "some-action", pretty: "Deleted action" });

    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [profile, deletedProfile],
      bindings: [binding, deletedBinding],
      actions: [menuAction, deepAction, someAction],
    };

    const result = deleteProfile(config, "prof-del");
    const actionIds = result.actions.map((a) => a.id).sort();

    // deep-action must survive because it's inside the submenu
    expect(actionIds).toEqual(["deep-action", "menu-action"]);
  });
});

// ---------------------------------------------------------------------------
// duplicateBinding
// ---------------------------------------------------------------------------

describe("duplicateBinding", () => {
  it("copies a binding and its action to a new control", () => {
    const action = makeAction({ id: "a1", pretty: "Copy Me" });
    const binding = makeBinding({
      id: "b1",
      profileId: "prof",
      layer: "standard",
      controlId: "thumb_01",
      actionRef: "a1",
    });
    const config = {
      ...createMinimalConfig(),
      actions: [action],
      bindings: [binding],
    };

    const result = duplicateBinding(config, "b1", "thumb_05");
    expect(result.bindings).toHaveLength(2);
    expect(result.actions).toHaveLength(2);

    const newBinding = result.bindings.find((b) => b.controlId === "thumb_05");
    expect(newBinding).toBeDefined();
    expect(newBinding!.profileId).toBe("prof");
    expect(newBinding!.layer).toBe("standard");

    const newAction = result.actions.find((a) => a.id !== "a1");
    expect(newAction).toBeDefined();
    expect(newAction!.pretty).toBe("Copy Me");
    expect(newBinding!.actionRef).toBe(newAction!.id);
  });

  it("removes any existing binding at the target slot", () => {
    const a1 = makeAction({ id: "a1" });
    const a2 = makeAction({ id: "a2" });
    const source = makeBinding({ id: "b1", profileId: "prof", controlId: "thumb_01", actionRef: "a1" });
    const target = makeBinding({ id: "b2", profileId: "prof", controlId: "thumb_05", actionRef: "a2" });
    const config = {
      ...createMinimalConfig(),
      actions: [a1, a2],
      bindings: [source, target],
    };

    const result = duplicateBinding(config, "b1", "thumb_05");
    // The old target binding (b2) should be removed, replaced by the copy
    const bindingsAtTarget = result.bindings.filter((b) => b.controlId === "thumb_05");
    expect(bindingsAtTarget).toHaveLength(1);
    expect(bindingsAtTarget[0]!.id).not.toBe("b2");
  });

  it("returns config unchanged when binding id is not found", () => {
    const config = createMinimalConfig();
    const result = duplicateBinding(config, "nonexistent", "thumb_05");
    expect(result).toBe(config);
  });

  it("returns config unchanged when the action referenced by binding is not found", () => {
    const binding = makeBinding({ id: "b1", actionRef: "missing-action" });
    const config = { ...createMinimalConfig(), bindings: [binding] };

    const result = duplicateBinding(config, "b1", "thumb_05");
    expect(result).toBe(config);
  });

  it("allows duplicating to a different layer via targetLayer param", () => {
    const action = makeAction({ id: "a1" });
    const binding = makeBinding({
      id: "b1",
      profileId: "prof",
      layer: "standard",
      controlId: "thumb_01",
      actionRef: "a1",
    });
    const config = {
      ...createMinimalConfig(),
      actions: [action],
      bindings: [binding],
    };

    const result = duplicateBinding(config, "b1", "thumb_01", "hypershift");
    const newBinding = result.bindings.find((b) => b.layer === "hypershift");
    expect(newBinding).toBeDefined();
    expect(newBinding!.controlId).toBe("thumb_01");
    expect(newBinding!.layer).toBe("hypershift");
  });
});

// ---------------------------------------------------------------------------
// copyBindingFromLayer
// ---------------------------------------------------------------------------

describe("copyBindingFromLayer", () => {
  it("copies a binding from standard layer to hypershift layer", () => {
    const action = makeAction({ id: "a1" });
    const binding = makeBinding({
      id: "b1",
      profileId: "prof",
      layer: "standard",
      controlId: "thumb_03",
      actionRef: "a1",
    });
    const config = {
      ...createMinimalConfig(),
      actions: [action],
      bindings: [binding],
    };

    const result = copyBindingFromLayer(config, "prof", "thumb_03", "standard", "hypershift");
    expect(result.bindings).toHaveLength(2);

    const hyperBinding = result.bindings.find((b) => b.layer === "hypershift");
    expect(hyperBinding).toBeDefined();
    expect(hyperBinding!.controlId).toBe("thumb_03");
    expect(hyperBinding!.profileId).toBe("prof");
  });

  it("returns config unchanged when no source binding exists", () => {
    const config = createMinimalConfig();
    const result = copyBindingFromLayer(config, "prof", "thumb_03", "standard", "hypershift");
    expect(result).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// expectedEncodedKeyForControl
// ---------------------------------------------------------------------------

describe("expectedEncodedKeyForControl", () => {
  // Thumb grid: standard layer
  it.each([
    ["thumb_01", "standard", "F13"],
    ["thumb_02", "standard", "F14"],
    ["thumb_03", "standard", "F15"],
    ["thumb_04", "standard", "F16"],
    ["thumb_05", "standard", "F17"],
    ["thumb_06", "standard", "F18"],
    ["thumb_07", "standard", "F19"],
    ["thumb_08", "standard", "F20"],
    ["thumb_09", "standard", "F21"],
    ["thumb_10", "standard", "F22"],
    ["thumb_11", "standard", "F23"],
    ["thumb_12", "standard", "F24"],
  ] as [ControlId, Layer, string][])(
    "returns %s for %s on %s layer",
    (controlId, layer, expected) => {
      expect(expectedEncodedKeyForControl(controlId, layer)).toBe(expected);
    },
  );

  // Thumb grid: hypershift layer
  it.each([
    ["thumb_01", "hypershift", "Ctrl+Alt+Shift+F13"],
    ["thumb_06", "hypershift", "Ctrl+Alt+Shift+F18"],
    ["thumb_12", "hypershift", "Ctrl+Alt+Shift+F24"],
  ] as [ControlId, Layer, string][])(
    "returns %s for %s on %s layer",
    (controlId, layer, expected) => {
      expect(expectedEncodedKeyForControl(controlId, layer)).toBe(expected);
    },
  );

  // Top panel controls
  it("returns Ctrl+Shift+F23 for top_aux_01 standard", () => {
    expect(expectedEncodedKeyForControl("top_aux_01", "standard")).toBe("Ctrl+Shift+F23");
  });

  it("returns Ctrl+Alt+F23 for top_aux_01 hypershift", () => {
    expect(expectedEncodedKeyForControl("top_aux_01", "hypershift")).toBe("Ctrl+Alt+F23");
  });

  it("returns Ctrl+Shift+F24 for top_aux_02 standard", () => {
    expect(expectedEncodedKeyForControl("top_aux_02", "standard")).toBe("Ctrl+Shift+F24");
  });

  it("returns Ctrl+Shift+F13 for mouse_4 standard", () => {
    expect(expectedEncodedKeyForControl("mouse_4", "standard")).toBe("Ctrl+Shift+F13");
  });

  it("returns Ctrl+Alt+F14 for mouse_5 hypershift", () => {
    expect(expectedEncodedKeyForControl("mouse_5", "hypershift")).toBe("Ctrl+Alt+F14");
  });

  it("returns Ctrl+Shift+F15 for wheel_click standard", () => {
    expect(expectedEncodedKeyForControl("wheel_click", "standard")).toBe("Ctrl+Shift+F15");
  });

  // wheel_up/down standard have null mappings
  it("returns null for wheel_up standard (not remappable in standard)", () => {
    expect(expectedEncodedKeyForControl("wheel_up", "standard")).toBeNull();
  });

  it("returns null for wheel_down standard", () => {
    expect(expectedEncodedKeyForControl("wheel_down", "standard")).toBeNull();
  });

  it("returns Ctrl+Alt+F16 for wheel_up hypershift", () => {
    expect(expectedEncodedKeyForControl("wheel_up", "hypershift")).toBe("Ctrl+Alt+F16");
  });

  it("returns Ctrl+Alt+F17 for wheel_down hypershift", () => {
    expect(expectedEncodedKeyForControl("wheel_down", "hypershift")).toBe("Ctrl+Alt+F17");
  });

  // Unknown controls
  it("returns null for unknown control id", () => {
    expect(expectedEncodedKeyForControl("mouse_left" as ControlId, "standard")).toBeNull();
  });

  it("returns null for hypershift_button", () => {
    expect(expectedEncodedKeyForControl("hypershift_button" as ControlId, "standard")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// makeBindingId
// ---------------------------------------------------------------------------

describe("makeBindingId", () => {
  it("produces a deterministic id with underscores normalized to hyphens", () => {
    expect(makeBindingId("prof-1", "standard", "thumb_01")).toBe(
      "binding-prof-1-standard-thumb-01",
    );
  });

  it("handles hypershift layer", () => {
    expect(makeBindingId("prof-1", "hypershift", "mouse_4")).toBe(
      "binding-prof-1-hypershift-mouse-4",
    );
  });

  it("handles control ids with multiple underscores", () => {
    expect(makeBindingId("p", "standard", "top_aux_01")).toBe(
      "binding-p-standard-top-aux-01",
    );
  });
});

// ---------------------------------------------------------------------------
// makeActionId
// ---------------------------------------------------------------------------

describe("makeActionId", () => {
  it("produces a deterministic id with underscores normalized to hyphens", () => {
    expect(makeActionId("prof-1", "standard", "thumb_01")).toBe(
      "action-prof-1-standard-thumb-01",
    );
  });

  it("handles hypershift layer", () => {
    expect(makeActionId("prof-1", "hypershift", "wheel_click")).toBe(
      "action-prof-1-hypershift-wheel-click",
    );
  });
});

// ---------------------------------------------------------------------------
// makeProfileId
// ---------------------------------------------------------------------------

describe("makeProfileId", () => {
  it("normalizes name to lowercase kebab-case", () => {
    expect(makeProfileId("Gaming Profile")).toBe("gaming-profile");
  });

  it("strips leading and trailing hyphens", () => {
    expect(makeProfileId("--Gaming--")).toBe("gaming");
  });

  it("returns 'profile' for empty or whitespace-only names", () => {
    expect(makeProfileId("")).toBe("profile");
    expect(makeProfileId("   ")).toBe("profile");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(makeProfileId("My @#$ Profile!")).toBe("my-profile");
  });

  it("collapses consecutive special characters into a single hyphen", () => {
    expect(makeProfileId("a   b")).toBe("a-b");
  });
});

// ---------------------------------------------------------------------------
// makeSnippetId
// ---------------------------------------------------------------------------

describe("makeSnippetId", () => {
  it("produces a snippet id prefixed with 'snippet-'", () => {
    expect(makeSnippetId("Hello World")).toBe("snippet-hello-world");
  });

  it("strips leading and trailing hyphens from normalized name", () => {
    expect(makeSnippetId("---Test---")).toBe("snippet-test");
  });

  it("returns 'snippet-custom' for empty name", () => {
    expect(makeSnippetId("")).toBe("snippet-custom");
    expect(makeSnippetId("   ")).toBe("snippet-custom");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(makeSnippetId("My Snippet! #1")).toBe("snippet-my-snippet-1");
  });
});

// ---------------------------------------------------------------------------
// makeAppMappingId
// ---------------------------------------------------------------------------

describe("makeAppMappingId", () => {
  it("produces an app mapping id prefixed with 'app-'", () => {
    expect(makeAppMappingId("chrome.exe")).toBe("app-chrome");
  });

  it("strips .exe suffix before normalizing", () => {
    expect(makeAppMappingId("Firefox.EXE")).toBe("app-firefox");
  });

  it("returns 'app-window' for empty exe name", () => {
    expect(makeAppMappingId("")).toBe("app-window");
    expect(makeAppMappingId("   ")).toBe("app-window");
  });

  it("handles paths by normalizing slashes", () => {
    expect(makeAppMappingId("C:\\Program Files\\app.exe")).toBe("app-c-program-files-app");
  });

  it("handles exe without extension", () => {
    expect(makeAppMappingId("notepad")).toBe("app-notepad");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty config
// ---------------------------------------------------------------------------

describe("edge cases: empty config", () => {
  it("findBinding returns null on empty config", () => {
    expect(findBinding(createMinimalConfig(), "any", "standard", "thumb_01")).toBeNull();
  });

  it("deleteProfile on empty config is a no-op", () => {
    const config = createMinimalConfig();
    const result = deleteProfile(config, "nonexistent");
    expect(result.profiles).toHaveLength(0);
    expect(result.bindings).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
  });

  it("duplicateBinding on empty config returns unchanged", () => {
    const config = createMinimalConfig();
    expect(duplicateBinding(config, "any", "thumb_01")).toBe(config);
  });

  it("coerceActionType on empty config returns unchanged", () => {
    const config = createMinimalConfig();
    expect(coerceActionType(config, "any", "shortcut")).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: conflicting IDs and immutability
// ---------------------------------------------------------------------------

describe("edge cases: conflicting IDs", () => {
  it("upsertBinding with the same id replaces in-place, not duplicates", () => {
    const b1 = makeBinding({ id: "conflict" });
    const config = { ...createMinimalConfig(), bindings: [b1] };

    const updated = { ...b1, label: "v2" };
    const result = upsertBinding(config, updated);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.label).toBe("v2");
  });

  it("createProfile generates suffix when id already exists", () => {
    const existing = makeProfile({ id: "test", name: "Test" });
    const config = { ...createMinimalConfig(), profiles: [existing] };

    const result = createProfile(config, "Test");
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[1]!.id).toBe("test-2");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: operations on non-existent entities
// ---------------------------------------------------------------------------

describe("edge cases: non-existent entities", () => {
  it("updateControlCapabilityStatus returns unchanged for missing control", () => {
    const config = createMinimalConfig();
    const result = updateControlCapabilityStatus(config, "thumb_01", "verified");
    expect(result).toBe(config);
  });

  it("promoteInlineSnippetActionToLibrary returns unchanged for missing action", () => {
    const config = createMinimalConfig();
    const result = promoteInlineSnippetActionToLibrary(config, "missing", "Name");
    expect(result).toBe(config);
  });

  it("copyBindingFromLayer returns unchanged when source does not exist", () => {
    const config = createMinimalConfig();
    const result = copyBindingFromLayer(config, "prof", "thumb_01", "standard", "hypershift");
    expect(result).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// Edge case: boundary - profile priority
// ---------------------------------------------------------------------------

describe("edge cases: profile priority", () => {
  it("calculates priority correctly with high existing priorities", () => {
    const p1 = makeProfile({ id: "p1", priority: 999990 });
    const config = { ...createMinimalConfig(), profiles: [p1] };

    const result = createProfile(config, "Next");
    expect(result.profiles[1]!.priority).toBe(1000000);
  });

  it("calculates priority from the maximum among multiple profiles", () => {
    const p1 = makeProfile({ id: "p1", priority: 5 });
    const p2 = makeProfile({ id: "p2", priority: 50 });
    const p3 = makeProfile({ id: "p3", priority: 20 });
    const config = { ...createMinimalConfig(), profiles: [p1, p2, p3] };

    const result = createProfile(config, "Next");
    expect(result.profiles[3]!.priority).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Immutability: all upsert functions return new objects
// ---------------------------------------------------------------------------

describe("immutability guarantees", () => {
  it("upsertBinding returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertBinding(config, makeBinding());
    expect(result).not.toBe(config);
  });

  it("upsertAction returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertAction(config, makeAction());
    expect(result).not.toBe(config);
  });

  it("upsertProfile returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertProfile(config, makeProfile());
    expect(result).not.toBe(config);
  });

  it("upsertPhysicalControl returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertPhysicalControl(config, makePhysicalControl());
    expect(result).not.toBe(config);
  });

  it("upsertAppMapping returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertAppMapping(config, makeAppMapping());
    expect(result).not.toBe(config);
  });

  it("upsertSnippetLibraryItem returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertSnippetLibraryItem(config, makeSnippetLibraryItem());
    expect(result).not.toBe(config);
  });

  it("upsertEncoderMapping returns a new config object", () => {
    const config = createMinimalConfig();
    const result = upsertEncoderMapping(config, makeEncoderMapping());
    expect(result).not.toBe(config);
  });

  it("createProfile returns a new config object", () => {
    const config = createMinimalConfig();
    const result = createProfile(config, "Test");
    expect(result).not.toBe(config);
  });

  it("deleteProfile returns a new config object", () => {
    const p = makeProfile({ id: "p" });
    const config = { ...createMinimalConfig(), profiles: [p] };
    const result = deleteProfile(config, "p");
    expect(result).not.toBe(config);
  });
});

// ---------------------------------------------------------------------------
// ActionCondition
// ---------------------------------------------------------------------------

describe("ActionCondition", () => {
  it("action with conditions preserves them through upsert", () => {
    const config = createMinimalConfig();
    const conditions: ActionCondition[] = [
      { type: "windowTitleContains", value: "Visual Studio" },
      { type: "exeNotEquals", value: "explorer.exe" },
    ];
    const action: Action = {
      id: "cond-test",
      type: "shortcut",
      payload: { key: "C", ctrl: true, shift: false, alt: false, win: false },
      pretty: "Ctrl+C",
      conditions,
    };
    const updated = upsertAction(config, action);
    const found = updated.actions.find((a) => a.id === "cond-test");
    expect(found?.conditions).toEqual(conditions);
  });

  it("action without conditions has undefined/empty conditions", () => {
    const config = createMinimalConfig();
    const action: Action = {
      id: "no-cond",
      type: "disabled",
      payload: {} as Record<string, never>,
      pretty: "Disabled",
    };
    const updated = upsertAction(config, action);
    const found = updated.actions.find((a) => a.id === "no-cond");
    expect(found?.conditions ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeBinding
// ---------------------------------------------------------------------------

describe("removeBinding", () => {
  it("removes a binding and its orphaned action", () => {
    const action = makeAction({ id: "action-orphan" });
    const binding = makeBinding({ id: "binding-rm", actionRef: "action-orphan" });
    const config: AppConfig = {
      ...createMinimalConfig(),
      bindings: [binding],
      actions: [action],
    };

    const result = removeBinding(config, "binding-rm");

    expect(result.bindings).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
  });

  it("keeps action if referenced by another binding", () => {
    const action = makeAction({ id: "action-shared" });
    const binding1 = makeBinding({ id: "binding-1", actionRef: "action-shared" });
    const binding2 = makeBinding({ id: "binding-2", actionRef: "action-shared", controlId: "thumb_02" as ControlId });
    const config: AppConfig = {
      ...createMinimalConfig(),
      bindings: [binding1, binding2],
      actions: [action],
    };

    const result = removeBinding(config, "binding-1");

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.id).toBe("binding-2");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.id).toBe("action-shared");
  });

  it("returns config unchanged if bindingId not found", () => {
    const action = makeAction();
    const binding = makeBinding();
    const config: AppConfig = {
      ...createMinimalConfig(),
      bindings: [binding],
      actions: [action],
    };

    const result = removeBinding(config, "nonexistent-binding");

    expect(result).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// extractProfileExport
// ---------------------------------------------------------------------------

describe("extractProfileExport", () => {
  it("extracts profile with its bindings, actions, and appMappings", () => {
    const profile = makeProfile({ id: "p1", name: "Gaming" });
    const action1 = makeAction({ id: "act-1", pretty: "Ctrl+C" });
    const action2 = makeAction({ id: "act-2", pretty: "Ctrl+V" });
    const binding1 = makeBinding({
      id: "b1",
      profileId: "p1",
      controlId: "thumb_01",
      actionRef: "act-1",
    });
    const binding2 = makeBinding({
      id: "b2",
      profileId: "p1",
      controlId: "thumb_02",
      actionRef: "act-2",
    });
    const appMapping = makeAppMapping({
      id: "app-1",
      profileId: "p1",
      exe: "game.exe",
    });
    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [profile],
      bindings: [binding1, binding2],
      actions: [action1, action2],
      appMappings: [appMapping],
    };

    const result = extractProfileExport(config, "p1");

    expect(result.version).toBe(2);
    expect(result.exportedAt).toBeTruthy();
    // exportedAt should be a valid ISO date string
    expect(() => new Date(result.exportedAt).toISOString()).not.toThrow();
    expect(result.profile).toEqual(profile);
    expect(result.bindings).toEqual([binding1, binding2]);
    expect(result.actions).toEqual([action1, action2]);
    expect(result.appMappings).toEqual([appMapping]);
  });

  it("only includes actions referenced by the profile's bindings", () => {
    const profileA = makeProfile({ id: "pA", name: "Profile A" });
    const profileB = makeProfile({ id: "pB", name: "Profile B" });
    const actionA = makeAction({ id: "act-a", pretty: "Action A" });
    const actionB = makeAction({ id: "act-b", pretty: "Action B" });
    const actionOrphan = makeAction({ id: "act-orphan", pretty: "Orphan" });
    const bindingA = makeBinding({
      id: "bA",
      profileId: "pA",
      controlId: "thumb_01",
      actionRef: "act-a",
    });
    const bindingB = makeBinding({
      id: "bB",
      profileId: "pB",
      controlId: "thumb_01",
      actionRef: "act-b",
    });
    const appMappingB = makeAppMapping({
      id: "app-b",
      profileId: "pB",
      exe: "other.exe",
    });
    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [profileA, profileB],
      bindings: [bindingA, bindingB],
      actions: [actionA, actionB, actionOrphan],
      appMappings: [appMappingB],
    };

    const result = extractProfileExport(config, "pA");

    expect(result.actions).toEqual([actionA]);
    expect(result.actions).not.toContainEqual(actionB);
    expect(result.actions).not.toContainEqual(actionOrphan);
    expect(result.bindings).toEqual([bindingA]);
    expect(result.appMappings).toEqual([]);
  });

  it("throws if profileId not found", () => {
    const config = createMinimalConfig();

    expect(() => extractProfileExport(config, "nonexistent")).toThrow(
      "Profile not found: nonexistent",
    );
  });
});

// ---------------------------------------------------------------------------
// mergeImportedProfile
// ---------------------------------------------------------------------------

function makeExportData(overrides: Partial<ProfileExportData> = {}): ProfileExportData {
  return {
    version: 2,
    exportedAt: "2026-03-14T12:00:00.000Z",
    profile: makeProfile({ id: "imported-profile", name: "Imported" }),
    bindings: [
      makeBinding({
        id: "imported-binding-1",
        profileId: "imported-profile",
        controlId: "thumb_01",
        actionRef: "imported-action-1",
      }),
    ],
    actions: [
      makeAction({ id: "imported-action-1", pretty: "Imported Action" }),
    ],
    appMappings: [
      makeAppMapping({
        id: "imported-app-1",
        profileId: "imported-profile",
        exe: "imported.exe",
      }),
    ],
    ...overrides,
  };
}

describe("mergeImportedProfile", () => {
  it("merges imported profile into existing config with no collisions", () => {
    const existingProfile = makeProfile({ id: "existing-profile", name: "Existing" });
    const existingAction = makeAction({ id: "existing-action", pretty: "Existing" });
    const existingBinding = makeBinding({
      id: "existing-binding",
      profileId: "existing-profile",
      actionRef: "existing-action",
    });
    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [existingProfile],
      actions: [existingAction],
      bindings: [existingBinding],
    };
    const exportData = makeExportData();

    const result = mergeImportedProfile(config, exportData);

    // Should have both profiles
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles.some((p) => p.name === "Imported")).toBe(true);

    // Should have both bindings
    expect(result.bindings).toHaveLength(2);

    // Should have both actions
    expect(result.actions).toHaveLength(2);

    // Should have the imported appMapping
    expect(result.appMappings).toHaveLength(1);

    // Imported binding should reference the imported profile and action
    const importedBinding = result.bindings.find((b) => b.id !== "existing-binding");
    expect(importedBinding).toBeDefined();
    const importedProfileInResult = result.profiles.find((p) => p.name === "Imported");
    expect(importedBinding!.profileId).toBe(importedProfileInResult!.id);
    const importedActionInResult = result.actions.find((a) => a.id !== "existing-action");
    expect(importedBinding!.actionRef).toBe(importedActionInResult!.id);

    // Imported appMapping should reference the imported profile
    const importedMapping = result.appMappings[0];
    expect(importedMapping!.profileId).toBe(importedProfileInResult!.id);
  });

  it("generates new IDs on collision and remaps internal references", () => {
    // Set up a config that has the SAME IDs as the import data
    const collidingProfile = makeProfile({ id: "imported-profile", name: "Collider" });
    const collidingAction = makeAction({ id: "imported-action-1", pretty: "Collider Action" });
    const collidingBinding = makeBinding({
      id: "imported-binding-1",
      profileId: "imported-profile",
      controlId: "thumb_03",
      actionRef: "imported-action-1",
    });
    const collidingAppMapping = makeAppMapping({
      id: "imported-app-1",
      profileId: "imported-profile",
      exe: "collider.exe",
    });
    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [collidingProfile],
      actions: [collidingAction],
      bindings: [collidingBinding],
      appMappings: [collidingAppMapping],
    };
    const exportData = makeExportData();

    const result = mergeImportedProfile(config, exportData);

    // Should have 2 profiles, 2 actions, 2 bindings, 2 appMappings
    expect(result.profiles).toHaveLength(2);
    expect(result.actions).toHaveLength(2);
    expect(result.bindings).toHaveLength(2);
    expect(result.appMappings).toHaveLength(2);

    // New profile ID should differ from original
    const newProfile = result.profiles.find((p) => p.id !== "imported-profile");
    expect(newProfile).toBeDefined();
    expect(newProfile!.name).toBe("Imported");

    // New action ID should differ from original
    const newAction = result.actions.find((a) => a.id !== "imported-action-1");
    expect(newAction).toBeDefined();
    expect(newAction!.pretty).toBe("Imported Action");

    // New binding ID should differ from original
    const newBinding = result.bindings.find((b) => b.id !== "imported-binding-1");
    expect(newBinding).toBeDefined();

    // Internal references must be updated:
    // binding.profileId -> new profile ID
    expect(newBinding!.profileId).toBe(newProfile!.id);
    // binding.actionRef -> new action ID
    expect(newBinding!.actionRef).toBe(newAction!.id);

    // New appMapping ID should differ from original
    const newAppMapping = result.appMappings.find((m) => m.id !== "imported-app-1");
    expect(newAppMapping).toBeDefined();
    // appMapping.profileId -> new profile ID
    expect(newAppMapping!.profileId).toBe(newProfile!.id);

    // Existing data should still be unchanged
    expect(result.profiles.find((p) => p.id === "imported-profile")).toEqual(collidingProfile);
    expect(result.actions.find((a) => a.id === "imported-action-1")).toEqual(collidingAction);
    expect(result.bindings.find((b) => b.id === "imported-binding-1")).toEqual(collidingBinding);
    expect(result.appMappings.find((m) => m.id === "imported-app-1")).toEqual(collidingAppMapping);
  });

  it("does not modify existing config data", () => {
    const existingProfile = makeProfile({ id: "keep-me", name: "Original" });
    const existingAction = makeAction({ id: "keep-action", pretty: "Original Action" });
    const existingBinding = makeBinding({
      id: "keep-binding",
      profileId: "keep-me",
      controlId: "thumb_02",
      actionRef: "keep-action",
    });
    const existingAppMapping = makeAppMapping({
      id: "keep-app",
      profileId: "keep-me",
      exe: "original.exe",
    });
    const config: AppConfig = {
      ...createMinimalConfig(),
      profiles: [existingProfile],
      actions: [existingAction],
      bindings: [existingBinding],
      appMappings: [existingAppMapping],
    };
    const exportData = makeExportData();

    const result = mergeImportedProfile(config, exportData);

    // Existing profile is preserved exactly
    expect(result.profiles.find((p) => p.id === "keep-me")).toEqual(existingProfile);

    // Existing action is preserved exactly
    expect(result.actions.find((a) => a.id === "keep-action")).toEqual(existingAction);

    // Existing binding is preserved exactly
    expect(result.bindings.find((b) => b.id === "keep-binding")).toEqual(existingBinding);

    // Existing appMapping is preserved exactly
    expect(result.appMappings.find((m) => m.id === "keep-app")).toEqual(existingAppMapping);

    // Original config arrays are not mutated
    expect(config.profiles).toHaveLength(1);
    expect(config.actions).toHaveLength(1);
    expect(config.bindings).toHaveLength(1);
    expect(config.appMappings).toHaveLength(1);
  });
});
