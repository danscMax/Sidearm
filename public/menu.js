// Menu popup — draws the view Rust sends (`menu-show`) and reports input.
// Rust owns the selection model (src-tauri/src/menu_popup.rs) and the window's
// size/position; this page only draws, measures itself and forwards input.
// The list never changes shape under the pointer: what the highlighted item
// sends shows in a tip beside it. Top-level submenus come as blocks (`group`).
// A radial look would be another drawing of the same view.
(function () {
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  var root = document.getElementById("menu");
  var view = null;
  var levelKey = "";
  var items = []; // the row elements of the level shown
  var highlight = -1;
  var search = null;
  var tip = null;
  var lastLayout = "";
  // The pointer's last screen position: a highlight follows the mouse only
  // when the mouse really moved, never because something changed under it.
  var lastPointer = null;
  // After a moment on one phrase the tip shows its whole text (same width,
  // scrollable): the window must not change size, or it moves under the pointer.
  var FULL_AFTER_MS = 600;
  var fullTimer = null;

  function invoke(cmd, args) {
    return tauri.invoke(cmd, args || {}).catch(function () {});
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildFrame() {
    root.textContent = "";
    var list = el("div", "list");
    var box = el("label", "search");
    box.appendChild(el("span", null, "⌕"));
    search = el("input");
    search.type = "text";
    search.spellcheck = false;
    search.addEventListener("input", function () { invoke("menu_search", { query: search.value }); });
    search.addEventListener("keydown", onKey);
    box.appendChild(search);
    list.appendChild(box);
    list.appendChild(el("div", "rows"));
    root.appendChild(list);
    var side = el("div", "side");
    tip = el("div", "tip");
    side.appendChild(tip);
    root.appendChild(side);
  }

  function buildRows() {
    var rows = root.querySelector(".rows");
    rows.textContent = "";
    items = [];
    if (view.parent != null) {
      var back = el("button", "back");
      back.appendChild(el("span", "back__arrow", "‹"));
      back.appendChild(el("span", null, view.parent));
      back.addEventListener("click", function () { invoke("menu_back"); });
      rows.appendChild(back);
      rows.appendChild(el("div", "group", view.title));
    }
    var group = null;
    view.items.forEach(function (item, index) {
      if ((item.group || null) !== group) {
        group = item.group || null;
        if (group) rows.appendChild(el("div", "group", group));
      }
      var row = el("div", "row" + (item.enabled ? "" : " item--off"));
      var keyClass = item.number == null ? "key key--none" : item.number > 12 ? "key key--extra" : "key";
      row.appendChild(el("span", keyClass, item.number != null ? String(item.number) : "0"));
      row.appendChild(el("span", "label", item.label));
      if (item.submenu) row.appendChild(el("span", "mark", "›"));
      if (item.enabled) row.addEventListener("click", function () { invoke("menu_pick", { index: index }); });
      // Right click: on a phrase how to use it (insert, insert + Enter, only
      // copy) or edit it; on a list only edit.
      if (item.enabled && (item.submenu || item.detail)) {
        row.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          showModes(index, event, item.submenu);
        });
      }
      rows.appendChild(row);
      items.push(row);
    });
    if (view.items.length === 0) rows.appendChild(el("div", "empty", view.empty));
    highlight = -1;
  }

  function showTip(index) {
    var item = view.items[index];
    var row = items[index];
    clearTimeout(fullTimer);
    tip.classList.remove("tip--full");
    if (!item || !row) { tip.style.visibility = "hidden"; return; }
    tip.style.visibility = "";
    tip.textContent = "";
    tip.classList.toggle("tip--list", !!(item.children && item.children.length));
    if (item.children && item.children.length) {
      // A submenu: what it holds, one name per line.
      // Each name is a button: it takes that item without opening the submenu first.
      item.children.forEach(function (name, child) {
        var entry = el("button", "tip__item", name);
        entry.type = "button";
        entry.addEventListener("click", function () { invoke("menu_pick_child", { index: index, child: child }); });
        tip.appendChild(entry);
      });
    } else {
      tip.textContent = item.detail || item.label;
    }
    tip.classList.remove("tip--fresh");
    void tip.offsetWidth;
    tip.classList.add("tip--fresh");
    var room = tip.parentNode.clientHeight;
    tip.style.maxHeight = room + "px";
    var rowTop = row.getBoundingClientRect().top - tip.parentNode.getBoundingClientRect().top;
    tip.style.top = Math.max(0, Math.min(rowTop - 4, room - tip.offsetHeight)) + "px";
    tip.classList.toggle("tip--clipped", tip.scrollHeight > tip.clientHeight + 1);
    if (!item.submenu && item.detail) {
      fullTimer = setTimeout(function () { showFull(index); }, FULL_AFTER_MS);
    }
  }

  /** The whole text of the phrase still highlighted, when the tip cut it. */
  function showFull(index) {
    if (!tip.classList.contains("tip--clipped") && !/…$/.test(view.items[index].detail || "")) return;
    tauri.invoke("menu_full_text", { index: index }).then(function (text) {
      if (highlight !== index || !text) return;
      tip.classList.add("tip--full");
      tip.classList.remove("tip--clipped");
      tip.textContent = text;
      var room = tip.parentNode.clientHeight;
      var rowTop = items[index].getBoundingClientRect().top - tip.parentNode.getBoundingClientRect().top;
      tip.style.top = Math.max(0, Math.min(rowTop - 4, room - tip.offsetHeight)) + "px";
    }).catch(function () {});
  }

  var modes = null;

  function hideModes() {
    if (modes) modes.remove();
    modes = null;
  }

  /** The right-click choices, over the list at the pointer (kept inside the window). */
  function showModes(index, event, listOnly) {
    hideModes();
    if (!items[index] || !view.pickModes || view.pickModes.length < 4) return;
    modes = el("div", "modes");
    (listOnly ? ["edit"] : ["run", "enter", "copy", "edit"]).forEach(function (mode) {
      var button = el("button", "tip__mode", view.pickModes[["run", "enter", "copy", "edit"].indexOf(mode)]);
      button.addEventListener("click", function () {
        hideModes();
        if (mode === "edit") invoke("menu_edit", { index: index });
        else invoke("menu_pick", { index: index, mode: mode });
      });
      modes.appendChild(button);
    });
    root.appendChild(modes);
    var box = root.getBoundingClientRect();
    var x = Math.min(event.clientX - box.left, box.width - modes.offsetWidth - 4);
    var y = Math.min(event.clientY - box.top, box.height - modes.offsetHeight - 4);
    modes.style.left = Math.max(4, x) + "px";
    modes.style.top = Math.max(4, y) + "px";
  }

  function setHighlight(index) {
    if (index === highlight) return;
    if (items[highlight]) items[highlight].classList.remove("item--on");
    highlight = index;
    if (items[index]) items[index].classList.add("item--on");
    showTip(index);
  }

  // Sent in physical pixels at the page's own scale, and again whenever the
  // content or the scale changes (a new window moved onto another monitor).
  function layout() {
    if (!view) return;
    var box = root.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var size = { generation: view.generation, width: Math.ceil(box.width * dpr), height: Math.ceil(box.height * dpr) };
    var key = JSON.stringify(size);
    if (key !== lastLayout) {
      lastLayout = key;
      invoke("menu_layout", size);
    }
  }

  function render(next) {
    var fresh = !view || next.generation !== view.generation;
    view = next;
    if (fresh) {
      buildFrame();
      search.placeholder = view.placeholder;
    }
    if (search.value !== view.query) search.value = view.query;
    var key = view.generation + "|" + view.title + "|" + view.query + "|" + view.items.length;
    if (key !== levelKey) {
      levelKey = key;
      buildRows();
      layout();
    }
    setHighlight(view.highlight);
    search.focus();
  }

  function onKey(event) {
    var handled = true;
    if (event.key === "ArrowDown") invoke("menu_wheel", { down: true });
    else if (event.key === "ArrowUp") invoke("menu_wheel", { down: false });
    else if (event.key === "Enter") invoke("menu_confirm");
    else if (event.key === "Escape") invoke("menu_close");
    else if (event.key === "Backspace" && search.value === "") invoke("menu_back");
    // The whole text of a long phrase scrolls with PageUp / PageDown.
    else if (event.key === "PageDown" || event.key === "PageUp") {
      tip.scrollBy({ top: (event.key === "PageDown" ? 1 : -1) * tip.clientHeight * 0.8 });
    }
    else handled = false;
    if (handled) event.preventDefault();
  }

  document.addEventListener("mousemove", function (event) {
    var moved = !lastPointer || lastPointer.x !== event.screenX || lastPointer.y !== event.screenY;
    lastPointer = { x: event.screenX, y: event.screenY };
    if (!moved) return;
    var row = event.target.closest && event.target.closest(".row");
    var index = items.indexOf(row);
    if (index >= 0 && index !== highlight && !row.classList.contains("item--off")) {
      invoke("menu_hover", { index: index });
    }
  });

  window.addEventListener("resize", layout);
  if (window.ResizeObserver) new ResizeObserver(layout).observe(root);
  // Never the browser's own menu (back, reload, print…).
  document.addEventListener("contextmenu", function (event) { event.preventDefault(); });
  // A click outside the right-click choices puts the tip back.
  document.addEventListener("mousedown", function (event) {
    if (modes && !modes.contains(event.target)) hideModes();
  });

  // A wheel Sidearm does not capture still steps through the list.
  document.addEventListener("wheel", function (event) {
    event.preventDefault();
    if (event.deltaY !== 0) invoke("menu_wheel", { down: event.deltaY > 0 });
  }, { passive: false });

  tauri.invoke("plugin:event|listen", {
    event: "menu-show",
    target: { kind: "Any" },
    handler: tauri.transformCallback(function (event) {
      if (event && event.payload) render(event.payload);
    }),
  }).then(function () { invoke("menu_ready"); });
})();
