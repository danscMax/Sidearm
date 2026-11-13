// HyperShift 2 cheat sheet — draws the grid Rust sends (`cheatsheet-show`) and
// reports its size; Rust places it at the cursor without taking the focus
// (src-tauri/src/cheatsheet.rs).
(function () {
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  var root = document.getElementById("sheet");

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function draw(sheet) {
    root.textContent = "";
    root.appendChild(el("div", "title", sheet.title));
    var grid = el("div", "grid");
    sheet.cells.forEach(function (cell) {
      var box = el("div", "cell");
      box.appendChild(el("span", "n", String(cell.number)));
      box.appendChild(el("div", cell.label ? "main" : "none", cell.label || "—"));
      (cell.extras || []).forEach(function (extra) { box.appendChild(el("div", "extra", extra)); });
      grid.appendChild(box);
    });
    root.appendChild(grid);
    var box = root.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    tauri.invoke("cheatsheet_layout", { width: Math.ceil(box.width * dpr), height: Math.ceil(box.height * dpr) }).catch(function () {});
  }

  tauri.invoke("plugin:event|listen", {
    event: "cheatsheet-show",
    target: { kind: "Any" },
    handler: tauri.transformCallback(function (event) { if (event && event.payload) draw(event.payload); }),
  }).then(function () { tauri.invoke("cheatsheet_ready").catch(function () {}); });
})();
