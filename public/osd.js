// OSD notification — receives profile switch events from Rust.
// Rust handles window sizing and positioning via Win32 API.
// JS only updates text content and plays animation.
if (window.__TAURI_INTERNALS__) {
  window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
    event: "osd-show",
    target: { kind: "Any" },
    handler: window.__TAURI_INTERNALS__.transformCallback(function (event) {
      var d = event.payload || {};
      var name = d.name || "Default";
      var fontSize = d.fontSize || "medium";
      var animation = d.animation || "slideIn";

      var el = document.getElementById("profile-name");
      var osd = document.getElementById("osd");

      el.textContent = name;

      osd.classList.remove(
        "osd--slide-in", "osd--fade-in", "osd--none",
        "osd--font-small", "osd--font-medium", "osd--font-large"
      );
      osd.style.opacity = "0";
      void osd.offsetWidth;

      if (fontSize === "small") osd.classList.add("osd--font-small");
      else if (fontSize === "large") osd.classList.add("osd--font-large");
      else osd.classList.add("osd--font-medium");

      osd.style.opacity = "";
      if (animation === "fadeIn") {
        osd.classList.add("osd--fade-in");
      } else if (animation === "none") {
        osd.classList.add("osd--none");
      } else {
        osd.classList.add("osd--slide-in");
      }
    }),
  });
}
