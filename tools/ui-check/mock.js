// Fake Tauri IPC for a browser check of the main window (an init script: it runs
// before the app's own code). The config comes from window.__UI_CONFIG__ (config.js,
// written by make-config.mjs). Only IPC is replaced; HTML/CSS/React stay real.
// window.__UI_CHECK__.unknown lists the commands nobody answers (they get null);
// window.__UI_CHECK__.emit(event, payload) fires a backend event at the page.
(() => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let config = window.__UI_CONFIG__ ? clone(window.__UI_CONFIG__) : null;
  const path = "C:\\ui-check\\data\\config.json";
  const runtime = { status: "running", startedAt: 1, lastReloadAt: null, captureBackend: "windows", activeConfigVersion: 12, warningCount: 0 };
  const answers = {
    load_config: () => {
      if (!config) throw { code: "ui_check", message: "No window.__UI_CONFIG__: run tools/ui-check/make-config.mjs first" };
      return { config: clone(config), warnings: [], path, createdDefault: false };
    },
    save_config: (args) => {
      config = clone(args.config);
      return { config: clone(config), warnings: [], path };
    },
    get_app_paths: () => ({
      mode: "portable", configDir: "C:\\ui-check\\data", logDir: "C:\\ui-check\\data\\logs",
      snapshotsDir: "C:\\ui-check\\data\\snapshots", portableMarkerPresent: true,
      needsPortableMigrationPrompt: false, testRun: false,
    }),
    list_native_mice: () => [],
    get_menu_usage: () => ({}),
    get_press_log: () => ({}),
    // Display fixtures only; the real firmware planner lives in Rust.
    get_offline_preview: ({ config: current, profileId, deviceId }) => ({
      target: (() => {
        if (current.settings.offlineProfileId === "@active") return { state: "followsWindow" };
        const writtenProfileId = current.settings.offlineProfileId || current.settings.fallbackProfileId;
        if (deviceId === "razer-naga-v3") {
          const banks = current.profiles.filter((profile) => profile.deviceSlots?.[deviceId] !== undefined)
            .map((profile) => ({ bank: profile.deviceSlots[deviceId], profileId: profile.id }));
          const bank = banks.find((entry) => entry.profileId === profileId)?.bank;
          return { state: bank === undefined ? "notWritten" : "written", bank, banks };
        }
        return { state: writtenProfileId === profileId ? "written" : "notWritten", writtenProfileId };
      })(),
      controls: current.physicalControls.filter((control) => control.deviceId === deviceId).flatMap((control) =>
        ["offline", "offlineHypershift"].map((layer) => {
          const bindings = current.bindings.filter((binding) => binding.enabled && binding.profileId === profileId
            && binding.controlId === control.id && (!binding.triggerMode || binding.triggerMode === "press"));
          const own = bindings.find((binding) => binding.layer === layer);
          const standard = bindings.find((binding) => binding.layer === (layer === "offlineHypershift" ? "hypershift" : "standard"))
            ?? bindings.find((binding) => binding.layer === "standard");
          const binding = own ?? standard;
          const action = current.actions.find((action) => action.id === binding?.actionId);
          if (layer === "offlineHypershift" && current.settings.hypershiftTrigger === "none") {
            return { controlId: control.id, layer, kind: "unavailable", editable: false, reason: "noTrigger" };
          }
          if (action && !["shortcut", "mouseAction", "disabled"].includes(action.type)) {
            return { controlId: control.id, layer, kind: "silent", actionId: action.id, editable: true,
              reason: "actionType", liveActionType: action.type };
          }
          if (action?.type === "disabled") return { controlId: control.id, layer, kind: "silent", actionId: action.id, editable: true };
          if (action?.type === "mouseAction" && ["ctrl", "shift", "alt", "win"].some((key) => action.payload[key])) {
            return { controlId: control.id, layer, kind: "silent", actionId: action.id, editable: true, reason: "mouseModifiers" };
          }
          return { controlId: control.id, layer, kind: own ? "own" : standard ? "inherited" : "preserved",
            ...(binding ? { actionId: binding.actionId } : {}), editable: true };
        })),
    }),
    list_backups: () => [],
    get_synapse_status: () => ({ running: false, startupRestoreAvailable: false }),
    start_runtime: () => runtime,
    get_runtime_state: () => runtime,
    get_mouse_status: () => [],
    get_admin_autostart_status: () => ({
      enabled: false, registeredPath: null, currentExe: "C:\\ui-check\\Sidearm.exe",
      pathMismatch: false, supported: true, needsReconfirm: false,
    }),
    get_debug_log: () => [],
    // The config's model, not plugged in (what the backend says with no mouse).
    get_native_model: (args) => ({
      name: "Razer Naga", deviceId: (args && args.deviceId) || "razer-naga", dpiMin: 100, dpiMax: 30000,
      pollRates: [125, 500, 1000], verified: true, connected: false, banks: false, consumerSignals: null,
    }),
    get_onboard_banks: () => ({ assigned: [1, 2], active: 1 }),
    create_onboard_bank: () => ({ assigned: [1, 2, 3], active: 1 }),
    delete_onboard_bank: ({ bank }) => ({ assigned: [1, 2, 3].filter((b) => b !== bank), active: 1 }),
    flush_onboard_banks: () => null,
    get_sidearm_bank: () => 4,
    release_sidearm_bank: () => true,
  };

  const callbacks = new Map();
  const listeners = new Map(); // event name -> [{ id, handler }]
  let nextId = 1;
  const unknown = new Set();

  window.__UI_CHECK__ = {
    unknown,
    emit(event, payload) {
      for (const { id, handler } of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id, payload });
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry.id !== id));
    },
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
    transformCallback(callback, once) {
      const id = nextId++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        return callback?.(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (filePath) => filePath,
    async invoke(command, args = {}) {
      if (command === "plugin:event|listen") {
        const id = nextId++;
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), { id, handler: args.handler }]);
        return id;
      }
      const answer = answers[command];
      if (answer) return answer(args);
      unknown.add(command);
      return null;
    },
  };
})();
