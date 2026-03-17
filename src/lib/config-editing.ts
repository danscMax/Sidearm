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

const PLACEHOLDER_ACTION_NOTE =
  "Created from the shell editor. Replace this placeholder before using it in runtime.";

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
  const actionStillReferenced = nextBindings.some((b) => b.actionRef === binding.actionRef);
  const nextActions = actionStillReferenced
    ? config.actions
    : config.actions.filter((a) => a.id !== binding.actionRef);
  return { ...config, bindings: nextBindings, actions: nextActions };
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
          pretty: "Menu target placeholder",
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
          payload: {
            key: "A",
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
          },
        };
      case "textSnippet":
        return {
          ...action,
          type: "textSnippet",
          payload: {
            source: "inline",
            text: action.pretty || "New snippet",
            pasteMode: "clipboardPaste",
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
                value: action.pretty.trim() || "Replace me",
              },
            ],
          },
        };
      case "launch":
        return {
          ...action,
          type: "launch",
          payload: {
            target: "C:\\Path\\To\\App.exe",
          },
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
                nextConfig.actions.find((candidate) => candidate.id === menuActionRef)?.pretty ??
                  "Menu target",
              ),
            ],
          },
        };
      case "mouseAction":
        return {
          ...action,
          type: "mouseAction",
          payload: { action: "leftClick" },
        };
      case "mediaKey":
        return {
          ...action,
          type: "mediaKey",
          payload: { key: "playPause" },
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

  const snippetName = preferredName.trim() || action.pretty.trim() || "New snippet";
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
    tags: uniqueTags(action.payload.tags),
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
  return config.appMappings.find(
    (m) => m.profileId === profileId && m.exe === normalizedExe,
  );
}

export interface CreateAppMappingResult {
  config: AppConfig;
  newMappingId: string;
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
  const normalizedExe = exe.trim().toLowerCase();
  if (!normalizedExe) {
    throw new Error("exe must not be empty");
  }
  const clampedPriority = Math.max(0, Math.min(9999, Math.round(priority)));
  const baseId = makeAppMappingId(normalizedExe);
  const nextId = nextUniqueId(
    config.appMappings.map((mapping) => mapping.id),
    baseId,
  );
  const nextMapping: AppMapping = {
    id: nextId,
    exe: normalizedExe,
    processPath: processPath || undefined,
    profileId,
    enabled: true,
    priority: clampedPriority,
    titleIncludes:
      includeTitleFilter && title.trim() ? [title.trim()] : undefined,
  };

  return {
    config: {
      ...config,
      appMappings: [...config.appMappings, nextMapping],
    },
    newMappingId: nextId,
  };
}

export function ensurePlaceholderBinding(
  config: AppConfig,
  profileId: string,
  layer: Layer,
  control: PhysicalControl,
): AppConfig {
  const existingBinding = findBinding(config, profileId, layer, control.id);
  if (existingBinding) {
    return config;
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
    actionRef: actionId,
    enabled: false,
  };

  if (actionIdSet.has(actionId)) {
    return {
      ...upsertBinding(config, nextBinding),
    };
  }

  const nextAction: Action = {
    id: actionId,
    type: "disabled",
    payload: {} as Record<string, never>,
    pretty: `Unassigned - ${control.defaultName}`,
    notes: PLACEHOLDER_ACTION_NOTE,
  };

  return {
    ...upsertBinding(config, nextBinding),
    actions: [...config.actions, nextAction],
  };
}

export function ensureEncoderMapping(
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

export function duplicateProfile(
  config: AppConfig,
  sourceProfileId: string,
): { config: AppConfig; newProfileId: string } {
  const source = config.profiles.find((p) => p.id === sourceProfileId);
  if (!source) return { config, newProfileId: "" };

  const newName = `${source.name} (копия)`;
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
    id: crypto.randomUUID(),
    profileId: newId,
  }));

  // Clone bindings + actions
  const sourceBindings = config.bindings.filter(
    (b) => b.profileId === sourceProfileId,
  );
  const actionIdMap = new Map<string, string>();
  const newActions: typeof config.actions = [];

  for (const binding of sourceBindings) {
    if (!actionIdMap.has(binding.actionRef)) {
      const sourceAction = config.actions.find((a) => a.id === binding.actionRef);
      if (sourceAction) {
        const newActionId = crypto.randomUUID();
        actionIdMap.set(binding.actionRef, newActionId);
        newActions.push({ ...structuredClone(sourceAction), id: newActionId });
      }
    }
  }

  const newBindings = sourceBindings.map((b) => ({
    ...b,
    id: crypto.randomUUID(),
    profileId: newId,
    actionRef: actionIdMap.get(b.actionRef) ?? b.actionRef,
  }));

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

  // Remove orphaned actions no longer referenced by any remaining binding.
  // Walk menu items recursively to preserve nested action refs.
  const referencedActionIds = new Set(nextBindings.map((b) => b.actionRef));
  for (const actionId of referencedActionIds) {
    const action = config.actions.find((a) => a.id === actionId);
    if (action?.type === "menu") {
      collectMenuActionRefs(action.payload.items, referencedActionIds);
    }
  }
  const nextActions = config.actions.filter((a) => referencedActionIds.has(a.id));

  return {
    ...config,
    profiles: config.profiles.filter((p) => p.id !== profileId),
    bindings: nextBindings,
    actions: nextActions,
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

  const action = config.actions.find((a) => a.id === binding.actionRef);
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
    actionRef: newActionId,
  };

  // Remove existing binding for target if any
  const filteredBindings = config.bindings.filter(
    (b) =>
      !(b.profileId === binding.profileId && b.layer === layer && b.controlId === targetControlId),
  );

  return {
    ...config,
    actions: [...config.actions, newAction],
    bindings: [...filteredBindings, newBinding],
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

  return normalized || "profile";
}

export function createDefaultActionMenuItem(
  existingIds: string[],
  actionRef: string,
  preferredLabel: string,
): MenuItem {
  return {
    kind: "action",
    id: nextUniqueId(existingIds, "menu-item-action"),
    label: preferredLabel.trim() || "Menu item",
    actionRef,
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
      refs.add(item.actionRef);
    } else if (item.kind === "submenu" && item.items) {
      collectMenuActionRefs(item.items, refs);
    }
  }
}

function normalizeControlToken(controlId: ControlId): string {
  return controlId.replace(/_/g, "-");
}

function makePlaceholderEncodedKey(layer: Layer, controlId: ControlId): string {
  return `TODO_${layer.toUpperCase()}_${controlId.toUpperCase()}`;
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();

  return tags.filter((tag) => {
    if (seen.has(tag)) {
      return false;
    }

    seen.add(tag);
    return true;
  });
}

function nextUniqueId(existingIds: string[] | Set<string>, baseId: string): string {
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
  const actionRefs = new Set(bindings.map((b) => b.actionRef));
  const actions = config.actions.filter((a) => actionRefs.has(a.id));
  const appMappings = config.appMappings.filter((m) => m.profileId === profileId);

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    profile,
    bindings,
    actions,
    appMappings,
  };
}

/** Merge an imported profile into an existing config, generating new IDs on collision. */
export function mergeImportedProfile(
  config: AppConfig,
  data: ProfileExportData,
): AppConfig {
  // Collect all existing IDs into a single Set for collision detection
  const existingIds = new Set<string>([
    ...config.profiles.map((p) => p.id),
    ...config.bindings.map((b) => b.id),
    ...config.actions.map((a) => a.id),
    ...config.appMappings.map((m) => m.id),
  ]);

  function resolveId(id: string): string {
    if (!existingIds.has(id)) return id;
    const newId = crypto.randomUUID();
    return newId;
  }

  // Build ID maps (old -> new) for all entity types
  const profileIdMap = new Map<string, string>();
  const actionIdMap = new Map<string, string>();
  const bindingIdMap = new Map<string, string>();
  const appMappingIdMap = new Map<string, string>();

  // Profile
  const newProfileId = resolveId(data.profile.id);
  profileIdMap.set(data.profile.id, newProfileId);

  // Actions
  for (const action of data.actions) {
    const newId = resolveId(action.id);
    actionIdMap.set(action.id, newId);
  }

  // Bindings
  for (const binding of data.bindings) {
    const newId = resolveId(binding.id);
    bindingIdMap.set(binding.id, newId);
  }

  // AppMappings
  for (const appMapping of data.appMappings) {
    const newId = resolveId(appMapping.id);
    appMappingIdMap.set(appMapping.id, newId);
  }

  // Build remapped entities
  const newProfile: Profile = {
    ...data.profile,
    id: profileIdMap.get(data.profile.id) ?? data.profile.id,
  };

  const newActions: Action[] = data.actions.map((a) => ({
    ...structuredClone(a),
    id: actionIdMap.get(a.id) ?? a.id,
  }));

  const newBindings: Binding[] = data.bindings.map((b) => ({
    ...b,
    id: bindingIdMap.get(b.id) ?? b.id,
    profileId: profileIdMap.get(b.profileId) ?? b.profileId,
    actionRef: actionIdMap.get(b.actionRef) ?? b.actionRef,
  }));

  const newAppMappings: AppMapping[] = data.appMappings.map((m) => ({
    ...m,
    id: appMappingIdMap.get(m.id) ?? m.id,
    profileId: profileIdMap.get(m.profileId) ?? m.profileId,
  }));

  return {
    ...config,
    profiles: [...config.profiles, newProfile],
    actions: [...config.actions, ...newActions],
    bindings: [...config.bindings, ...newBindings],
    appMappings: [...config.appMappings, ...newAppMappings],
  };
}

/** Extract a single profile and all its related data for export. */
export function extractProfileForExport(
  config: AppConfig,
  profileId: string,
): {
  profile: Profile;
  appMappings: AppMapping[];
  bindings: Binding[];
  actions: Action[];
  encoderMappings: EncoderMapping[];
} | null {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) return null;

  const appMappings = config.appMappings.filter((m) => m.profileId === profileId);
  const bindings = config.bindings.filter((b) => b.profileId === profileId);
  const actionRefs = new Set(bindings.map((b) => b.actionRef));
  const actions = config.actions.filter((a) => actionRefs.has(a.id));
  const encoderMappings = config.encoderMappings.filter(
    (e) => bindings.some((b) => b.controlId === e.controlId && b.layer === e.layer),
  );

  return { profile, appMappings, bindings, actions, encoderMappings };
}

/** Import a profile from exported data, assigning new IDs to avoid conflicts. */
export function importProfile(
  config: AppConfig,
  data: {
    profile: Profile;
    appMappings: AppMapping[];
    bindings: Binding[];
    actions: Action[];
    encoderMappings: EncoderMapping[];
  },
): AppConfig {
  const existingIds = config.profiles.map((p) => p.id);
  const newId = nextUniqueId(existingIds, makeProfileId(data.profile.name));
  const newName = existingIds.includes(data.profile.id)
    ? `${data.profile.name} (импорт)`
    : data.profile.name;

  const actionIdMap = new Map<string, string>();
  const newActions: Action[] = data.actions.map((a) => {
    const id = crypto.randomUUID();
    actionIdMap.set(a.id, id);
    return { ...structuredClone(a), id };
  });

  const newBindings: Binding[] = data.bindings.map((b) => ({
    ...b,
    id: crypto.randomUUID(),
    profileId: newId,
    actionRef: actionIdMap.get(b.actionRef) ?? b.actionRef,
  }));

  const newAppMappings: AppMapping[] = data.appMappings.map((m) => ({
    ...m,
    id: crypto.randomUUID(),
    profileId: newId,
  }));

  return {
    ...config,
    profiles: [...config.profiles, { ...data.profile, id: newId, name: newName }],
    appMappings: [...config.appMappings, ...newAppMappings],
    bindings: [...config.bindings, ...newBindings],
    actions: [...config.actions, ...newActions],
    encoderMappings: [
      ...config.encoderMappings,
      ...data.encoderMappings.filter(
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

