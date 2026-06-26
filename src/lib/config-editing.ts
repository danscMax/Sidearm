import i18n from "../i18n";
import type {
  Action,
  ActionType,
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
import { clampPriority, uniqueStrings } from "./helpers";
import { defaultPayloadFor } from "./action-helpers";

const PLACEHOLDER_ACTION_NOTE =
  "Created from the shell editor. Replace this placeholder before using it in runtime.";

/** True for the auto-created "Unassigned" placeholder action (a disabled action
 *  carrying the placeholder note). Lets callers tell a first-time assignment
 *  apart from editing a real, deliberately-saved action. */
export function isPlaceholderAction(action: Action | null | undefined): boolean {
  return !!action && action.type === "disabled" && action.notes === PLACEHOLDER_ACTION_NOTE;
}

const TOP_PANEL_MAP: Record<string, { standard: string | null; hypershift: string | null }> = {
  top_aux_01: { standard: "Ctrl+Shift+F23", hypershift: "Ctrl+Alt+F23" },
  top_aux_02: { standard: "Ctrl+Shift+F24", hypershift: "Ctrl+Alt+F24" },
  mouse_4: { standard: "Ctrl+Shift+F13", hypershift: "Ctrl+Alt+F13" },
  mouse_5: { standard: "Ctrl+Shift+F14", hypershift: "Ctrl+Alt+F14" },
  wheel_click: { standard: "Ctrl+Shift+F15", hypershift: "Ctrl+Alt+F15" },
  wheel_up: { standard: null, hypershift: "Ctrl+Alt+F16" },
  wheel_down: { standard: null, hypershift: "Ctrl+Alt+F17" },
};

export function findBinding(
  config: AppConfig,
  profileId: string,
  layer: Layer,
  controlId: ControlId,
): Binding | null {
  return (
    config.bindings.find(
      (binding) =>
        binding.profileId === profileId &&
        binding.layer === layer &&
        binding.controlId === controlId,
    ) ?? null
  );
}

export function removeBinding(config: AppConfig, bindingId: string): AppConfig {
  const binding = config.bindings.find((b) => b.id === bindingId);
  if (!binding) return config;
  const nextBindings = config.bindings.filter((b) => b.id !== bindingId);
  const actionStillReferenced = nextBindings.some((b) => b.actionId === binding.actionId);
  if (actionStillReferenced) {
    return { ...config, bindings: nextBindings };
  }
  // The action is now orphaned. Preserve any inline snippet text in the library
  // before dropping it, so user-authored content is never silently lost.
  const dropped = config.actions.filter((a) => a.id === binding.actionId);
  return {
    ...config,
    bindings: nextBindings,
    actions: config.actions.filter((a) => a.id !== binding.actionId),
    snippetLibrary: rescueDroppedSnippets(dropped, config.snippetLibrary),
  };
}

export function upsertBinding(config: AppConfig, nextBinding: Binding): AppConfig {
  const bindingIndex = config.bindings.findIndex(
    (binding) => binding.id === nextBinding.id,
  );

  if (bindingIndex === -1) {
    return {
      ...config,
      bindings: [...config.bindings, nextBinding],
    };
  }

  const bindings = [...config.bindings];
  bindings[bindingIndex] = nextBinding;

  return {
    ...config,
    bindings,
  };
}

export function upsertEncoderMapping(
  config: AppConfig,
  nextMapping: EncoderMapping,
): AppConfig {
  const mappingIndex = config.encoderMappings.findIndex(
    (mapping) =>
      mapping.controlId === nextMapping.controlId && mapping.layer === nextMapping.layer,
  );

  if (mappingIndex === -1) {
    return {
      ...config,
      encoderMappings: [...config.encoderMappings, nextMapping],
    };
  }

  const encoderMappings = [...config.encoderMappings];
  encoderMappings[mappingIndex] = nextMapping;

  return {
    ...config,
    encoderMappings,
  };
}

export function upsertAction(config: AppConfig, nextAction: Action): AppConfig {
  const actionIndex = config.actions.findIndex((action) => action.id === nextAction.id);

  if (actionIndex === -1) {
    return {
      ...config,
      actions: [...config.actions, nextAction],
    };
  }

  const actions = [...config.actions];
  actions[actionIndex] = nextAction;

  return {
    ...config,
    actions,
  };
}

export function upsertProfile(config: AppConfig, nextProfile: Profile): AppConfig {
  const profileIndex = config.profiles.findIndex((profile) => profile.id === nextProfile.id);

  if (profileIndex === -1) {
    return {
      ...config,
      profiles: [...config.profiles, nextProfile],
    };
  }

  const profiles = [...config.profiles];
  profiles[profileIndex] = nextProfile;

  return {
    ...config,
    profiles,
  };
}

export function upsertPhysicalControl(
  config: AppConfig,
  nextControl: PhysicalControl,
): AppConfig {
  const controlIndex = config.physicalControls.findIndex(
    (control) => control.id === nextControl.id,
  );

  if (controlIndex === -1) {
    return {
      ...config,
      physicalControls: [...config.physicalControls, nextControl],
    };
  }

  const physicalControls = [...config.physicalControls];
  physicalControls[controlIndex] = nextControl;

  return {
    ...config,
    physicalControls,
  };
}

export function deleteAppMapping(config: AppConfig, appMappingId: string): AppConfig {
  return {
    ...config,
    appMappings: config.appMappings.filter((m) => m.id !== appMappingId),
  };
}

/**
 * Reorder appMappings within a profile by moving `draggedId` to the position
 * currently held by `targetId`. Rebalances priority for that profile to a
 * descending sequence (length*10, ..., 20, 10, 0) so visually-higher cards
 * have higher priority. Mappings in other profiles are untouched.
 *
 * No-op if the IDs are missing or belong to different profiles.
 */
export function reorderAppMappingPriority(
  config: AppConfig,
  draggedId: string,
  targetId: string,
): AppConfig {
  if (draggedId === targetId) return config;

  const dragged = config.appMappings.find((m) => m.id === draggedId);
  const target = config.appMappings.find((m) => m.id === targetId);
  if (!dragged || !target || dragged.profileId !== target.profileId) {
    return config;
  }

  const profileId = dragged.profileId;
  const same = config.appMappings
    .filter((m) => m.profileId === profileId)
    .sort((a, b) => b.priority - a.priority || a.exe.localeCompare(b.exe));

  const fromIdx = same.findIndex((m) => m.id === draggedId);
  const toIdx = same.findIndex((m) => m.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return config;

  const reordered = [...same];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(toIdx, 0, moved);

  const total = reordered.length;
  const priorityById = new Map<string, number>();
  reordered.forEach((m, i) => priorityById.set(m.id, (total - i) * 10));

  return {
    ...config,
    appMappings: config.appMappings.map((m) =>
      m.profileId === profileId
        ? { ...m, priority: priorityById.get(m.id) ?? m.priority }
        : m,
    ),
  };
}

export function upsertAppMapping(config: AppConfig, nextAppMapping: AppMapping): AppConfig {
  const appMappingIndex = config.appMappings.findIndex(
    (mapping) => mapping.id === nextAppMapping.id,
  );

  if (appMappingIndex === -1) {
    return {
      ...config,
      appMappings: [...config.appMappings, nextAppMapping],
    };
  }

  const appMappings = [...config.appMappings];
  appMappings[appMappingIndex] = nextAppMapping;

  return {
    ...config,
    appMappings,
  };
}

export function upsertSnippetLibraryItem(
  config: AppConfig,
  nextSnippet: SnippetLibraryItem,
): AppConfig {
  const snippetIndex = config.snippetLibrary.findIndex(
    (snippet) => snippet.id === nextSnippet.id,
  );

  if (snippetIndex === -1) {
    return {
      ...config,
      snippetLibrary: [...config.snippetLibrary, nextSnippet],
    };
  }

  const snippetLibrary = [...config.snippetLibrary];
  snippetLibrary[snippetIndex] = nextSnippet;

  return {
    ...config,
    snippetLibrary,
  };
}

/** Delete a library snippet, re-inlining its text into every button that linked
 *  to it (source: libraryRef → inline) so no action is left runtime-dead with a
 *  dangling snippetId. The inverse of {@link promoteInlineSnippetActionToLibrary}. */
export function removeSnippetLibraryItem(config: AppConfig, snippetId: string): AppConfig {
  const snippet = config.snippetLibrary.find((s) => s.id === snippetId);
  const actions = snippet
    ? config.actions.map((action) =>
        action.type === "textSnippet" &&
        action.payload.source === "libraryRef" &&
        action.payload.snippetId === snippetId
          ? {
              ...action,
              payload: {
                source: "inline" as const,
                text: snippet.text,
                pasteMode: snippet.pasteMode,
                tags: uniqueStrings(snippet.tags),
              },
            }
          : action,
      )
    : config.actions;

  return {
    ...config,
    actions,
    snippetLibrary: config.snippetLibrary.filter((s) => s.id !== snippetId),
  };
}

/** Actions that resolve their text from this library snippet (source: libraryRef). */
export function snippetReferencingActions(config: AppConfig, snippetId: string): Action[] {
  return config.actions.filter(
    (action) =>
      action.type === "textSnippet" &&
      action.payload.source === "libraryRef" &&
      action.payload.snippetId === snippetId,
  );
}

/** Count of actions linking to this snippet — drives the delete-confirm warning. */
export function snippetReferenceCount(config: AppConfig, snippetId: string): number {
  return snippetReferencingActions(config, snippetId).length;
}

export interface SnippetLibraryExportData {
  version: number;
  exportedAt: string;
  snippets: SnippetLibraryItem[];
}

/** Structural guard for a parsed snippet-library export envelope. */
export function isValidSnippetLibraryExport(raw: unknown): raw is SnippetLibraryExportData {
  if (typeof raw !== "object" || raw === null) return false;
  return Array.isArray((raw as Record<string, unknown>).snippets);
}

/** Merge imported snippets into the library: an identical snippet (same id +
 *  text + paste mode) is skipped; an id collision with different content gets a
 *  fresh unique id; empty-text entries are dropped (the backend rejects them). */
export function mergeSnippetLibrary(
  config: AppConfig,
  incoming: SnippetLibraryItem[],
): AppConfig {
  const existingIds = new Set(config.snippetLibrary.map((s) => s.id));
  const added: SnippetLibraryItem[] = [];
  for (const snippet of incoming) {
    if (!snippet.text?.trim()) continue;
    const local = config.snippetLibrary.find((s) => s.id === snippet.id);
    if (local && local.text === snippet.text && local.pasteMode === snippet.pasteMode) continue;
    const id = local ? nextUniqueId(existingIds, makeSnippetId(snippet.name)) : snippet.id;
    existingIds.add(id);
    added.push({
      id,
      name: snippet.name,
      text: snippet.text,
      pasteMode: snippet.pasteMode,
      tags: uniqueStrings(snippet.tags ?? []),
      ...(snippet.notes ? { notes: snippet.notes } : {}),
    });
  }
  return { ...config, snippetLibrary: [...config.snippetLibrary, ...added] };
}

export function coerceActionType(
  config: AppConfig,
  actionId: string,
  nextType: ActionType,
): AppConfig {
  const action = config.actions.find((candidate) => candidate.id === actionId);
  if (!action || action.type === nextType) {
    return config;
  }

  let nextConfig = config;
  let menuActionRef =
    config.actions.find((candidate) => candidate.id !== actionId)?.id ?? null;

  if (nextType === "menu" && !menuActionRef) {
    const placeholderActionId = nextUniqueId(
      config.actions.map((candidate) => candidate.id),
      "action-menu-target",
    );
    nextConfig = {
      ...config,
      actions: [
        ...config.actions,
        {
          id: placeholderActionId,
          type: "disabled",
          payload: {} as Record<string, never>,
          displayName: "Menu target placeholder",
          notes: PLACEHOLDER_ACTION_NOTE,
        },
      ],
    };
    menuActionRef = placeholderActionId;
  }

  const nextAction: Action = (() => {
    switch (nextType) {
      case "shortcut":
        return {
          ...action,
          type: "shortcut",
          payload: defaultPayloadFor("shortcut"),
        };
      case "textSnippet":
        // Special case: seed the snippet text from the action's display name so
        // a freshly-converted snippet isn't blank (preserves prior behaviour).
        return {
          ...action,
          type: "textSnippet",
          payload: {
            source: "inline",
            text: action.displayName || "New snippet",
            pasteMode: "sendText",
            tags: [],
          },
        };
      case "sequence":
        return {
          ...action,
          type: "sequence",
          payload: {
            steps: [
              {
                type: "text",
                value: action.displayName.trim() || i18n.t("sequence.defaultText"),
              },
            ],
          },
        };
      case "launch":
        return {
          ...action,
          type: "launch",
          payload: defaultPayloadFor("launch"),
        };
      case "menu":
        return {
          ...action,
          type: "menu",
          payload: {
            items: [
              createDefaultActionMenuItem(
                [],
                menuActionRef ?? actionId,
                nextConfig.actions.find((candidate) => candidate.id === menuActionRef)?.displayName ??
                  "Menu target",
              ),
            ],
          },
        };
      case "mouseAction": {
        // DECIDED FORK: carry the source's keyboard modifiers into the new
        // mouseAction. Only `shortcut` carries modifiers into here (the early
        // return above rules out source === mouseAction), so read them from it.
        const carried =
          action.type === "shortcut"
            ? {
                ctrl: action.payload.ctrl,
                shift: action.payload.shift,
                alt: action.payload.alt,
                win: action.payload.win,
              }
            : {};
        return {
          ...action,
          type: "mouseAction",
          payload: { ...defaultPayloadFor("mouseAction"), ...carried },
        };
      }
      case "mediaKey":
        return {
          ...action,
          type: "mediaKey",
          payload: defaultPayloadFor("mediaKey"),
        };
      case "profileSwitch":
        return {
          ...action,
          type: "profileSwitch",
          payload: { targetProfileId: nextConfig.profiles[0]?.id ?? "" },
        };
      case "disabled":
        return {
          ...action,
          type: "disabled",
          payload: {} as Record<string, never>,
          notes: action.notes ?? PLACEHOLDER_ACTION_NOTE,
        };
      case "repairClipboard":
        return {
          ...action,
          type: "repairClipboard",
          payload: defaultPayloadFor("repairClipboard"),
        };
    }
  })();

  return upsertAction(nextConfig, nextAction);
}

export function promoteInlineSnippetActionToLibrary(
  config: AppConfig,
  actionId: string,
  preferredName: string,
): AppConfig {
  const action = config.actions.find((candidate) => candidate.id === actionId);
  if (
    !action ||
    action.type !== "textSnippet" ||
    action.payload.source !== "inline"
  ) {
    return config;
  }

  const snippetName = preferredName.trim() || action.displayName.trim() || "New snippet";
  const baseSnippetId = makeSnippetId(snippetName);
  const snippetId = nextUniqueId(
    config.snippetLibrary.map((snippet) => snippet.id),
    baseSnippetId,
  );
  const nextSnippet: SnippetLibraryItem = {
    id: snippetId,
    name: snippetName,
    text: action.payload.text,
    pasteMode: action.payload.pasteMode,
    tags: uniqueStrings(action.payload.tags),
    notes: action.notes,
  };

  const withSnippet = upsertSnippetLibraryItem(config, nextSnippet);

  return upsertAction(withSnippet, {
    ...action,
    payload: {
      source: "libraryRef",
      snippetId,
    },
  });
}

/** Finds existing app mapping for same exe+profile (ignoring title filters). */
export function findDuplicateAppMapping(
  config: AppConfig,
  profileId: string,
  exe: string,
): AppMapping | undefined {
  const normalizedExe = exe.trim().toLowerCase();
  // Compare case-insensitively on BOTH sides: stored `m.exe` is canonical
  // lowercase when created via createAppMappingFromCapture, but an imported
  // profile (importProfile) historically stored it verbatim, so a mixed-case
  // entry would otherwise slip past this duplicate check.
  return config.appMappings.find(
    (m) => m.profileId === profileId && m.exe.trim().toLowerCase() === normalizedExe,
  );
}

export interface CreateAppMappingResult {
  config: AppConfig;
  newMappingId: string;
}

/**
 * Insert a new app-mapping built from a full draft — the unified rule card uses
 * this for "create". Assigns a unique id, trims+lowercases the exe, clamps the
 * priority, and drops empty title filters. Throws if the exe is empty.
 * {@link createAppMappingFromCapture} is the single-title convenience wrapper.
 */
export function createAppMapping(
  config: AppConfig,
  draft: Omit<AppMapping, "id">,
): CreateAppMappingResult {
  const normalizedExe = draft.exe.trim().toLowerCase();
  if (!normalizedExe) {
    throw new Error("exe must not be empty");
  }
  const baseId = makeAppMappingId(normalizedExe);
  const nextId = nextUniqueId(
    config.appMappings.map((mapping) => mapping.id),
    baseId,
  );
  const titleIncludes = (draft.titleIncludes ?? [])
    .map((title) => title.trim())
    .filter((title) => title.length > 0);
  const nextMapping: AppMapping = {
    ...draft,
    id: nextId,
    exe: normalizedExe,
    processPath: draft.processPath || undefined,
    priority: clampPriority(draft.priority),
    titleIncludes: titleIncludes.length > 0 ? titleIncludes : undefined,
  };

  return {
    config: {
      ...config,
      appMappings: [...config.appMappings, nextMapping],
    },
    newMappingId: nextId,
  };
}

export function createAppMappingFromCapture(
  config: AppConfig,
  profileId: string,
  priority: number,
  exe: string,
  title: string,
  includeTitleFilter: boolean,
  processPath?: string,
): CreateAppMappingResult {
  return createAppMapping(config, {
    exe,
    processPath,
    profileId,
    enabled: true,
    priority,
    titleIncludes:
      includeTitleFilter && title.trim() ? [title.trim()] : undefined,
  });
}

/** Result of {@link ensurePlaceholderBinding}: the (possibly unchanged) config
 *  plus the id of the binding that now backs the (profile, layer, control) slot.
 *  Returning the real id avoids reconstructing it at the call site, which would
 *  diverge from the actually-created id on a base-id collision (audit F010). */
export interface EnsurePlaceholderBindingResult {
  config: AppConfig;
  bindingId: string;
}

export function ensurePlaceholderBinding(
  config: AppConfig,
  profileId: string,
  layer: Layer,
  control: PhysicalControl,
): EnsurePlaceholderBindingResult {
  const existingBinding = findBinding(config, profileId, layer, control.id);
  if (existingBinding) {
    return { config, bindingId: existingBinding.id };
  }

  const baseActionId = makeActionId(profileId, layer, control.id);
  const actionIdSet = new Set(config.actions.map((action) => action.id));
  const actionId = actionIdSet.has(baseActionId)
    ? baseActionId
    : nextUniqueId(actionIdSet, baseActionId);
  const baseBindingId = makeBindingId(profileId, layer, control.id);
  const bindingId = nextUniqueId(new Set(config.bindings.map((binding) => binding.id)), baseBindingId);

  const nextBinding: Binding = {
    id: bindingId,
    profileId,
    layer,
    controlId: control.id,
    label: `Unassigned - ${control.defaultName}`,
    actionId: actionId,
    enabled: false,
  };

  if (actionIdSet.has(actionId)) {
    return {
      config: { ...upsertBinding(config, nextBinding) },
      bindingId,
    };
  }

  const nextAction: Action = {
    id: actionId,
    type: "disabled",
    payload: {} as Record<string, never>,
    displayName: `Unassigned - ${control.defaultName}`,
    notes: PLACEHOLDER_ACTION_NOTE,
  };

  return {
    config: {
      ...upsertBinding(config, nextBinding),
      actions: [...config.actions, nextAction],
    },
    bindingId,
  };
}

function ensureEncoderMapping(
  config: AppConfig,
  layer: Layer,
  control: PhysicalControl,
): AppConfig {
  const existingMapping = config.encoderMappings.find(
    (mapping) => mapping.layer === layer && mapping.controlId === control.id,
  );
  if (existingMapping) {
    return config;
  }

  return {
    ...config,
    encoderMappings: [
      ...config.encoderMappings,
      {
        controlId: control.id,
        layer,
        encodedKey: makePlaceholderEncodedKey(layer, control.id),
        source: "detected",
        verified: false,
      },
    ],
  };
}

export function seedExpectedEncoderMapping(
  config: AppConfig,
  layer: Layer,
  control: PhysicalControl,
): AppConfig {
  const expectedEncodedKey = expectedEncodedKeyForControl(control.id, layer);
  if (!expectedEncodedKey) {
    return ensureEncoderMapping(config, layer, control);
  }

  return upsertEncoderMapping(config, {
    controlId: control.id,
    layer,
    encodedKey: expectedEncodedKey,
    source: "synapse",
    verified: false,
  });
}

export function updateControlCapabilityStatus(
  config: AppConfig,
  controlId: ControlId,
  capabilityStatus: CapabilityStatus,
): AppConfig {
  const control = config.physicalControls.find((candidate) => candidate.id === controlId);
  if (!control || control.capabilityStatus === capabilityStatus) {
    return config;
  }

  return upsertPhysicalControl(config, {
    ...control,
    capabilityStatus,
  });
}

export function expectedEncodedKeyForControl(
  controlId: ControlId,
  layer: Layer,
): string | null {
  const thumbIndex = thumbGridIndex(controlId);
  if (thumbIndex !== null) {
    const baseFunction = 13 + thumbIndex;
    return layer === "standard"
      ? `F${baseFunction}`
      : `Ctrl+Alt+Shift+F${baseFunction}`;
  }

  // Top panel controls – direct mapping to match Synapse layout
  const entry = TOP_PANEL_MAP[controlId];
  if (entry) {
    const key = layer === "standard" ? entry.standard : entry.hypershift;
    return key ?? null;
  }

  return null;
}

/** Re-key a set of bindings onto a new profile: fresh random binding ids, the
 *  new profileId, and actionIds remapped through `actionIdMap` (falling back to
 *  the original id when unmapped). Shared by duplicateProfile and importProfile,
 *  which previously had byte-identical copies of this block. */
function remapBindings(
  bindings: Binding[],
  newProfileId: string,
  actionIdMap: Map<string, string>,
): Binding[] {
  return bindings.map((b) => ({
    ...b,
    id: makeRandomId("binding"),
    profileId: newProfileId,
    actionId: actionIdMap.get(b.actionId) ?? b.actionId,
  }));
}

export function duplicateProfile(
  config: AppConfig,
  sourceProfileId: string,
): { config: AppConfig; newProfileId: string } {
  const source = config.profiles.find((p) => p.id === sourceProfileId);
  if (!source) return { config, newProfileId: "" };

  const newName = i18n.t("profile.duplicateName", { name: source.name });
  const newId = nextUniqueId(
    config.profiles.map((p) => p.id),
    makeProfileId(newName),
  );

  const newProfile: Profile = { ...source, id: newId, name: newName };

  // Clone all appMappings for this profile
  const sourceAppMappings = config.appMappings.filter(
    (m) => m.profileId === sourceProfileId,
  );
  const newAppMappings = sourceAppMappings.map((m) => ({
    ...m,
    id: makeRandomId("app"),
    profileId: newId,
    // Store exe canonically (lowercase) so the duplicate check and the
    // case-insensitive runtime resolver agree, matching importProfile /
    // createAppMappingFromCapture.
    exe: m.exe.trim().toLowerCase(),
  }));

  // Clone bindings + actions
  const sourceBindings = config.bindings.filter(
    (b) => b.profileId === sourceProfileId,
  );
  const actionIdMap = new Map<string, string>();
  const newActions: typeof config.actions = [];

  for (const binding of sourceBindings) {
    if (!actionIdMap.has(binding.actionId)) {
      const sourceAction = config.actions.find((a) => a.id === binding.actionId);
      if (sourceAction) {
        const newActionId = makeRandomId("action");
        actionIdMap.set(binding.actionId, newActionId);
        newActions.push({ ...structuredClone(sourceAction), id: newActionId });
      }
    }
  }

  const newBindings = remapBindings(sourceBindings, newId, actionIdMap);

  return {
    config: {
      ...config,
      profiles: [...config.profiles, newProfile],
      appMappings: [...config.appMappings, ...newAppMappings],
      bindings: [...config.bindings, ...newBindings],
      actions: [...config.actions, ...newActions],
    },
    newProfileId: newId,
  };
}

export function createProfile(config: AppConfig, preferredName: string): AppConfig {
  const name = preferredName.trim() || "New Profile";
  const id = nextUniqueId(config.profiles.map((profile) => profile.id), makeProfileId(name));
  const nextPriority =
    (config.profiles.reduce(
      (highestPriority, profile) => Math.max(highestPriority, profile.priority),
      0,
    ) || 0) + 10;

  return {
    ...config,
    profiles: [
      ...config.profiles,
      {
        id,
        name,
        enabled: true,
        priority: nextPriority,
      },
    ],
  };
}

export function deleteProfile(config: AppConfig, profileId: string): AppConfig {
  const nextBindings = config.bindings.filter((b) => b.profileId !== profileId);

  // Remove orphaned actions no longer referenced by any remaining binding
  // (menu-aware: nested action refs are preserved).
  const { actions: nextActions, snippetLibrary } = pruneActionsPreservingSnippets(
    config.actions,
    nextBindings,
    config.snippetLibrary,
  );

  return {
    ...config,
    profiles: config.profiles.filter((p) => p.id !== profileId),
    bindings: nextBindings,
    actions: nextActions,
    snippetLibrary,
    appMappings: config.appMappings.filter((m) => m.profileId !== profileId),
  };
}

export function duplicateBinding(
  config: AppConfig,
  bindingId: string,
  targetControlId: ControlId,
  targetLayer?: Layer,
): AppConfig {
  const binding = config.bindings.find((b) => b.id === bindingId);
  if (!binding) return config;

  const action = config.actions.find((a) => a.id === binding.actionId);
  if (!action) return config;

  const layer = targetLayer ?? binding.layer;

  // Clone action
  const newActionId = nextUniqueId(
    config.actions.map((a) => a.id),
    `${action.id}-copy`,
  );
  const newAction: Action = { ...structuredClone(action), id: newActionId };

  // Clone binding
  const newBindingId = nextUniqueId(
    config.bindings.map((b) => b.id),
    makeBindingId(binding.profileId, layer, targetControlId),
  );
  const newBinding: Binding = {
    ...binding,
    id: newBindingId,
    controlId: targetControlId,
    layer,
    actionId: newActionId,
  };

  // Remove existing binding for target if any
  const filteredBindings = config.bindings.filter(
    (b) =>
      !(b.profileId === binding.profileId && b.layer === layer && b.controlId === targetControlId),
  );

  const nextBindings = [...filteredBindings, newBinding];
  // Audit F040: if the replaced target binding was the last reference to its
  // action, that action would otherwise be orphaned. Prune it the same way
  // removeBinding/deleteProfile do (menu-aware), so duplication can't leak
  // dangling actions into the config.
  const { actions: nextActions, snippetLibrary } = pruneActionsPreservingSnippets(
    [...config.actions, newAction],
    nextBindings,
    config.snippetLibrary,
  );

  return {
    ...config,
    actions: nextActions,
    bindings: nextBindings,
    snippetLibrary,
  };
}

export function copyBindingFromLayer(
  config: AppConfig,
  profileId: string,
  controlId: ControlId,
  sourceLayer: Layer,
  targetLayer: Layer,
): AppConfig {
  const sourceBinding = findBinding(config, profileId, sourceLayer, controlId);
  if (!sourceBinding) return config;
  return duplicateBinding(config, sourceBinding.id, controlId, targetLayer);
}

export function makeBindingId(
  profileId: string,
  layer: Layer,
  controlId: ControlId,
): string {
  return `binding-${profileId}-${layer}-${normalizeControlToken(controlId)}`;
}

export function makeActionId(
  profileId: string,
  layer: Layer,
  controlId: ControlId,
): string {
  return `action-${profileId}-${layer}-${normalizeControlToken(controlId)}`;
}

export function makeSnippetId(name: string): string {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `snippet-${normalized || "custom"}`;
}

export function makeAppMappingId(exe: string): string {
  const normalized = exe
    .toLowerCase()
    .trim()
    .replace(/\.exe$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `app-${normalized || "window"}`;
}

export function makeProfileId(name: string): string {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const base = normalized || "profile";
  // Schema idToken requires a leading letter (^[a-z][a-z0-9-]*$). A name starting
  // with a digit ("2nd profile", "3D") would otherwise yield a schema-invalid id and
  // make save fail (audit F013). Mirror makeAppMappingId's letter-prefix guarantee.
  return /^[a-z]/.test(base) ? base : `p-${base}`;
}

// Generates a schema-compliant id matching ^[a-z][a-z0-9-]*$.
// The prefix must start with a lowercase letter; the suffix is random hex.
export function makeRandomId(prefix: string): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}-${hex}`;
}

export function createDefaultActionMenuItem(
  existingIds: string[],
  actionId: string,
  preferredLabel: string,
): MenuItem {
  return {
    kind: "action",
    id: nextUniqueId(existingIds, "menu-item-action"),
    label: preferredLabel.trim() || "Menu item",
    actionId,
    enabled: true,
  };
}

export function createDefaultSubmenuItem(
  existingIds: string[],
  childActionRef: string,
  childLabel: string,
): MenuItem {
  const submenuId = nextUniqueId(existingIds, "menu-item-submenu");
  return {
    kind: "submenu",
    id: submenuId,
    label: "Submenu",
    enabled: true,
    items: [
      createDefaultActionMenuItem(
        [...existingIds, submenuId],
        childActionRef,
        childLabel,
      ),
    ],
  };
}

export function collectMenuActionRefs(items: MenuItem[], refs: Set<string>): void {
  for (const item of items) {
    if (item.kind === "action") {
      refs.add(item.actionId);
    } else if (item.kind === "submenu" && item.items) {
      collectMenuActionRefs(item.items, refs);
    }
  }
}

/** Action ids reachable from `nextBindings`, directly or via nested menu refs. */
function computeReferencedActionIds(actions: Action[], nextBindings: Binding[]): Set<string> {
  const referencedActionIds = new Set(nextBindings.map((b) => b.actionId));
  // Live iteration: collectMenuActionRefs may add ids that themselves point at
  // menu actions, and `for...of` over a Set visits entries added mid-iteration.
  for (const actionId of referencedActionIds) {
    const action = actions.find((a) => a.id === actionId);
    if (action?.type === "menu") {
      collectMenuActionRefs(action.payload.items, referencedActionIds);
    }
  }
  return referencedActionIds;
}

/** Before discarding actions, preserve any inline text-snippet content in the
 *  snippet library so user-authored text is never silently lost when a binding
 *  is reassigned/removed or its profile deleted. Deduped by exact text. */
function rescueDroppedSnippets(
  dropped: Action[],
  snippetLibrary: SnippetLibraryItem[],
): SnippetLibraryItem[] {
  let library = snippetLibrary;
  for (const action of dropped) {
    if (action.type !== "textSnippet" || action.payload.source !== "inline") {
      continue;
    }
    const text = action.payload.text;
    if (!text.trim()) {
      continue;
    }
    // Already preserved somewhere — don't pile up duplicates of the same text.
    if (library.some((snippet) => snippet.text === text)) {
      continue;
    }
    const name = action.displayName.trim() || text.trim().slice(0, 40);
    const id = nextUniqueId(
      library.map((snippet) => snippet.id),
      makeSnippetId(name),
    );
    library = [
      ...library,
      {
        id,
        name,
        text,
        pasteMode: action.payload.pasteMode,
        tags: uniqueStrings(action.payload.tags),
        notes: action.notes,
      },
    ];
  }
  return library;
}

/** Drop actions that no binding references (directly or via a menu payload),
 *  preserving dropped inline snippet text in the library. `nextBindings` is the
 *  binding set that should survive; reachable actions are kept, the rest pruned. */
function pruneActionsPreservingSnippets(
  actions: Action[],
  nextBindings: Binding[],
  snippetLibrary: SnippetLibraryItem[],
): { actions: Action[]; snippetLibrary: SnippetLibraryItem[] } {
  const referencedActionIds = computeReferencedActionIds(actions, nextBindings);
  const kept: Action[] = [];
  const dropped: Action[] = [];
  for (const action of actions) {
    if (referencedActionIds.has(action.id)) {
      kept.push(action);
    } else {
      dropped.push(action);
    }
  }
  return {
    actions: kept,
    snippetLibrary: rescueDroppedSnippets(dropped, snippetLibrary),
  };
}

function normalizeControlToken(controlId: ControlId): string {
  return controlId.replace(/_/g, "-");
}

function makePlaceholderEncodedKey(layer: Layer, controlId: ControlId): string {
  return `TODO_${layer.toUpperCase()}_${controlId.toUpperCase()}`;
}


export function nextUniqueId(existingIds: string[] | Set<string>, baseId: string): string {
  const idSet = existingIds instanceof Set ? existingIds : new Set(existingIds);
  if (!idSet.has(baseId)) {
    return baseId;
  }

  let index = 2;
  const limit = idSet.size + 1000;
  while (idSet.has(`${baseId}-${index}`) && index < limit) {
    index += 1;
  }

  return `${baseId}-${index}`;
}

export interface ProfileExportData {
  version: number;
  exportedAt: string;
  profile: Profile;
  bindings: Binding[];
  actions: Action[];
  appMappings: AppMapping[];
  /** Encoder (wheel/dial) mappings for the profile's controls. Optional for
   *  backward compatibility with v2 files and bundled presets that predate it. */
  encoderMappings?: EncoderMapping[];
  /** Library snippets referenced by the exported actions (source: libraryRef).
   *  Without these a cross-machine import resolves libraryRef buttons to
   *  "snippet not found". Optional for back-compat with older export files. */
  snippetLibrary?: SnippetLibraryItem[];
}

/** Structural validation for a parsed profile-export envelope. Guards against
 *  importing the wrong JSON shape; does not deep-validate nested entries. */
export function isValidProfileExport(raw: unknown): raw is ProfileExportData {
  if (typeof raw !== "object" || raw === null) return false;
  const d = raw as Record<string, unknown>;
  return Boolean(d.profile) && Array.isArray(d.bindings) && Array.isArray(d.actions);
}

/** Extract a single profile with its bindings, actions, and app mappings into an export envelope. */
export function extractProfileExport(
  config: AppConfig,
  profileId: string,
): ProfileExportData {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  const bindings = config.bindings.filter((b) => b.profileId === profileId);
  const actionRefs = new Set(bindings.map((b) => b.actionId));
  const actions = config.actions.filter((a) => actionRefs.has(a.id));
  const appMappings = config.appMappings.filter((m) => m.profileId === profileId);
  const encoderMappings = config.encoderMappings.filter((e) =>
    bindings.some((b) => b.controlId === e.controlId && b.layer === e.layer),
  );

  // Bundle the library snippets the exported actions link to, so a libraryRef
  // button still resolves after a cross-machine import.
  const referencedSnippetIds = new Set(
    actions
      .filter((a) => a.type === "textSnippet" && a.payload.source === "libraryRef")
      .map((a) => (a.payload as { snippetId: string }).snippetId),
  );
  const snippetLibrary = config.snippetLibrary.filter((s) => referencedSnippetIds.has(s.id));

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    profile,
    bindings,
    actions,
    appMappings,
    encoderMappings,
    snippetLibrary,
  };
}

/** Import a profile from exported data, assigning new IDs to avoid conflicts. */
export function importProfile(
  config: AppConfig,
  data: ProfileExportData,
): AppConfig {
  const existingIds = config.profiles.map((p) => p.id);
  const newId = nextUniqueId(existingIds, makeProfileId(data.profile.name));
  const newName = existingIds.includes(data.profile.id)
    ? i18n.t("profile.importName", { name: data.profile.name })
    : data.profile.name;

  // Merge imported library snippets, minting a fresh id for any that collide
  // with a local snippet of a different content; libraryRef actions are then
  // remapped to the resolved id so the link survives the import.
  const existingSnippetIds = new Set(config.snippetLibrary.map((s) => s.id));
  const snippetIdMap = new Map<string, string>();
  const newSnippets: SnippetLibraryItem[] = [];
  for (const snippet of data.snippetLibrary ?? []) {
    const local = config.snippetLibrary.find((s) => s.id === snippet.id);
    if (local && local.text === snippet.text && local.pasteMode === snippet.pasteMode) {
      // Identical snippet already present — reuse it, import nothing.
      snippetIdMap.set(snippet.id, local.id);
      continue;
    }
    const id = local
      ? nextUniqueId(existingSnippetIds, makeSnippetId(snippet.name))
      : snippet.id;
    existingSnippetIds.add(id);
    snippetIdMap.set(snippet.id, id);
    newSnippets.push({ ...structuredClone(snippet), id });
  }

  const actionIdMap = new Map<string, string>();
  const newActions: Action[] = data.actions.map((a) => {
    const id = makeRandomId("action");
    actionIdMap.set(a.id, id);
    const cloned = structuredClone(a);
    if (cloned.type === "textSnippet" && cloned.payload.source === "libraryRef") {
      const remapped = snippetIdMap.get(cloned.payload.snippetId);
      if (remapped) cloned.payload.snippetId = remapped;
    }
    return { ...cloned, id };
  });

  const newBindings: Binding[] = remapBindings(data.bindings, newId, actionIdMap);

  const newAppMappings: AppMapping[] = (data.appMappings ?? []).map((m) => ({
    ...m,
    id: makeRandomId("app"),
    profileId: newId,
    // Store exe canonically (lowercase) so the duplicate check and the
    // case-insensitive runtime resolver agree, matching createAppMappingFromCapture.
    exe: (m.exe ?? "").trim().toLowerCase(),
  }));

  return {
    ...config,
    profiles: [...config.profiles, { ...data.profile, id: newId, name: newName }],
    appMappings: [...config.appMappings, ...newAppMappings],
    bindings: [...config.bindings, ...newBindings],
    actions: [...config.actions, ...newActions],
    snippetLibrary: [...config.snippetLibrary, ...newSnippets],
    encoderMappings: [
      ...config.encoderMappings,
      ...(data.encoderMappings ?? []).filter(
        (e) => !config.encoderMappings.some(
          (existing) => existing.controlId === e.controlId && existing.layer === e.layer,
        ),
      ),
    ],
  };
}

function thumbGridIndex(controlId: ControlId): number | null {
  const match = /^thumb_(\d{2})$/.exec(controlId);
  if (!match) {
    return null;
  }

  const index = Number(match[1]) - 1;
  return index >= 0 && index < 12 ? index : null;
}

