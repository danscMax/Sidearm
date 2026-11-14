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
