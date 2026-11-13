// HyperShift 2 cheat sheet — draws the grid Rust sends (`cheatsheet-show`) and
// reports its size; Rust places it at the cursor without taking the focus
// (src-tauri/src/cheatsheet.rs).
(function () {
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  var root = document.getElementById("sheet");

  // The same marks as the main window's chips (GestureIcon.tsx): a held dot,
  // two or three dots.
  var SVG = "http://www.w3.org/2000/svg";
  function mark(gesture) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 10");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "10");
    svg.setAttribute("class", "mark");
    var shapes = gesture === "longPress"
      ? [["circle", { cx: 3.5, cy: 5, r: 2.6 }], ["rect", { x: 6.8, y: 4, width: 8, height: 2, rx: 1, opacity: 0.6 }]]
      : (gesture === "doublePress" ? [5, 11] : [3, 8, 13]).map(function (x) { return ["circle", { cx: x, cy: 5, r: 2.1 }]; });
    shapes.forEach(function (shape) {
      var node = document.createElementNS(SVG, shape[0]);
      Object.keys(shape[1]).forEach(function (key) { node.setAttribute(key, shape[1][key]); });
      node.setAttribute("fill", "currentColor");
      svg.appendChild(node);
    });
    return svg;
  }

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
      (cell.extras || []).forEach(function (extra) {
        var line = el("div", "extra");
        line.appendChild(mark(extra.gesture));
        line.appendChild(el("span", null, extra.label));
        box.appendChild(line);
      });
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
