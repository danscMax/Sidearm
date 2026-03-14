// Provide __TAURI_INTERNALS__ stub so @tauri-apps/api works in jsdom environment
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {
    plugins: {},
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    invoke: () => Promise.resolve(),
  },
  writable: true,
});
