// Listen for profile switch events from Rust
if (window.__TAURI_INTERNALS__) {
  window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
    event: "osd-show",
    target: { kind: "Any" },
    handler: window.__TAURI_INTERNALS__.transformCallback((event) => {
      const name = event.payload || "Default";
      const el = document.getElementById("profile-name");
      const osd = document.getElementById("osd");
      el.textContent = name;
      // Replay animation
      osd.classList.remove("osd--animate");
      void osd.offsetWidth; // force reflow
      osd.classList.add("osd--animate");
    }),
  });
}
