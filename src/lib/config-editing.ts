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
    !("source" in action.payload) ||
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

export function createAppMappingFromCapture(
  config: AppConfig,
  profileId: string,
  priority: number,
  exe: string,
  title: string,
  includeTitleFilter: boolean,
): AppConfig {
  const normalizedExe = exe.trim().toLowerCase();
  const baseId = makeAppMappingId(normalizedExe);
  const nextId = nextUniqueId(
    config.appMappings.map((mapping) => mapping.id),
    baseId,
  );
  const nextMapping: AppMapping = {
    id: nextId,
    exe: normalizedExe,
    profileId,
    enabled: true,
    priority,
    titleIncludes:
      includeTitleFilter && title.trim() ? [title.trim()] : undefined,
  };

  return {
    ...config,
    appMappings: [...config.appMappings, nextMapping],
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
  const actionId = config.actions.some((action) => action.id === baseActionId)
    ? baseActionId
    : nextUniqueId(config.actions.map((action) => action.id), baseActionId);
  const baseBindingId = makeBindingId(profileId, layer, control.id);
  const bindingId = nextUniqueId(config.bindings.map((binding) => binding.id), baseBindingId);

  const nextBinding: Binding = {
    id: bindingId,
    profileId,
    layer,
    controlId: control.id,
    label: `Unassigned - ${control.defaultName}`,
    actionRef: actionId,
    enabled: false,
  };

  if (config.actions.some((action) => action.id === actionId)) {
    return {
      ...upsertBinding(config, nextBinding),
    };
  }

  const nextAction: Action = {
    id: actionId,
    type: "disabled",
    payload: {},
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

  const plannedIndex = plannedValidationIndex(controlId);
  if (plannedIndex !== null) {
    const baseFunction = 13 + plannedIndex;
    return layer === "standard"
      ? `Ctrl+F${baseFunction}`
      : `Ctrl+Shift+F${baseFunction}`;
  }

  return null;
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

function nextUniqueId(existingIds: string[], baseId: string): string {
  if (!existingIds.includes(baseId)) {
    return baseId;
  }

  let index = 2;
  while (existingIds.includes(`${baseId}-${index}`)) {
    index += 1;
  }

  return `${baseId}-${index}`;
}

function thumbGridIndex(controlId: ControlId): number | null {
  const match = /^thumb_(\d{2})$/.exec(controlId);
  if (!match) {
    return null;
  }

  const index = Number(match[1]) - 1;
  return index >= 0 && index < 12 ? index : null;
}

function plannedValidationIndex(controlId: ControlId): number | null {
  const orderedControls: ControlId[] = [
    "top_aux_01",
    "top_aux_02",
    "mouse_4",
    "mouse_5",
    "wheel_up",
    "wheel_down",
    "wheel_click",
    "wheel_left",
    "wheel_right",
    "top_special_01",
    "top_special_02",
    "top_special_03",
  ];

  const index = orderedControls.indexOf(controlId);
  return index === -1 ? null : index;
}
