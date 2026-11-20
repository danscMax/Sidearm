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
  var searchBox = null;
  var scope = null;
  var tip = null;
  var lastLayout = "";
  // The pointer's last screen position: a highlight follows the mouse only
  // when the mouse really moved, never because something changed under it.
  var lastPointer = null;
  // After a moment on one phrase the tip shows its whole text (same width,
  // scrollable): the window must not change size, or it moves under the pointer.
  var FULL_AFTER_MS = 600;
  /** The widest a submenu's list in the tip gets (272 px each). */
  var MAX_TIP_COLUMNS = 5;
  var fullTimer = null;
  // Where Rust put the tip (`menu_layout`'s answer): left of the list when the
  // right has no room, and how wide it may get there (CSS px). Fixed per menu,
  // so hovering a long submenu never moves the list.
  var sideLeft = false;
  var sideRoom = Infinity;
  var tipColumn = 0;

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
    searchBox = box;
    box.appendChild(el("span", null, "⌕"));
    search = el("input");
    search.type = "text";
    search.spellcheck = false;
    // In a cheat sheet the box is out of sight: typing dims the cells that do not match.
    search.addEventListener("input", function () {
      // A menu without a search box: the hidden field keeps the keys, typing searches nothing.
      if (view && !view.searchOn) { search.value = ""; return; }
      invoke("menu_search", { query: search.value });
    });
    search.addEventListener("keydown", onKey);
    box.appendChild(search);
    // This menu or all menus; Tab switches it too. The click keeps the focus in the box.
    scope = el("button", "scope");
    scope.type = "button";
    scope.addEventListener("mousedown", function (event) { event.preventDefault(); });
    scope.addEventListener("click", toggleScope);
    box.appendChild(scope);
    list.appendChild(box);
    list.appendChild(el("div", "rows"));
    root.appendChild(list);
    var side = el("div", "side");
    tip = el("div", "tip");
    side.appendChild(tip);
    root.appendChild(side);
  }

  function toggleScope() {
    if (view && view.hasOthers) invoke("menu_search_scope", { all: !view.searchAll });
  }

  /** The label with the part the query matched marked (a match only through
   *  the other keyboard layout stays unmarked). */
  function labelNode(text, query) {
    var node = el("span", "label");
    var needle = (query || "").trim();
    var at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    if (at < 0) {
      node.textContent = text;
      return node;
    }
    node.appendChild(document.createTextNode(text.slice(0, at)));
    node.appendChild(el("mark", null, text.slice(at, at + needle.length)));
    node.appendChild(document.createTextNode(text.slice(at + needle.length)));
    return node;
  }

  /** A cheat sheet: the mouse's 12 side buttons as its grid (3 across), each
   *  cell its number, its action and its other press patterns. The header
   *  shows the typed query and the layer Tab switches to. */
  function buildGrid(rows) {
    var head = el("div", "sheet-title");
    head.appendChild(el("span", "sheet-title__name", view.title));
    if (view.query) head.appendChild(el("span", "sheet-query", "⌕ " + view.query));
    if (view.switchLayer) {
      var hint = el("span", "sheet-switch");
      hint.appendChild(el("kbd", null, "Tab"));
      hint.appendChild(document.createTextNode(" " + view.switchLayer));
      head.appendChild(hint);
    }
    rows.appendChild(head);
    view.items.forEach(function (item, index) {
      var cell = el("div", "row cell" + (item.enabled ? "" : " item--off") + (item.dim ? " cell--dim" : ""));
      cell.appendChild(el("span", "key", String(item.number != null ? item.number : index + 1)));
      var body = el("div", "cell__body");
      body.appendChild(item.label ? labelNode(item.label, view.query) : el("span", "label", "—"));
      (item.extras || []).forEach(function (extra) { body.appendChild(el("span", "cell__extra", extra)); });
      cell.appendChild(body);
      if (item.enabled) cell.addEventListener("click", function () { invoke("menu_pick", { index: index }); });
      rows.appendChild(cell);
      items.push(cell);
    });
  }

  /** The search box where the menu's editor put it (`view.searchPlace`, Rust
   *  decides): fixed above or below the rows, or at its row among them. Off:
   *  out of sight, still holding the keys. Returns the row it goes to, or -1. */
  function placeSearch(list, rows) {
    root.classList.toggle("menu--nosearch", !view.grid && !view.searchOn);
    var at = -1;
    if (view.searchPlace === "row") view.items.forEach(function (item, index) { if (item.search) at = index; });
    var bottom = view.searchPlace === "bottom";
    searchBox.classList.toggle("search--bottom", bottom);
    searchBox.classList.toggle("search--inline", at >= 0);
    if (at >= 0) return at; // put among the rows by buildRows
    if (bottom) list.appendChild(searchBox);
    else list.insertBefore(searchBox, rows);
    return -1;
  }

  function buildRows() {
    var rows = root.querySelector(".rows");
    rows.textContent = "";
    items = [];
    var inlineAt = view.grid ? -1 : placeSearch(rows.parentNode, rows);
    root.classList.toggle("menu--grid", !!view.grid);
    rows.classList.toggle("rows--grid", !!view.grid);
    if (view.grid) {
      buildGrid(rows);
      highlight = -1;
      return;
    }
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
      // The search box's own row: the box itself, or an empty mark when it sits above or below.
      if (item.search) {
        var place = index === inlineAt ? searchBox : el("div", "search-mark");
        rows.appendChild(place);
        items.push(place);
        return;
      }
      // A line between items: no number, nothing to pick (kept in `items` so indices line up).
      if (item.separator) {
        var line = el("div", "line");
        rows.appendChild(line);
        items.push(line);
        return;
      }
      var row = el("div", "row" + (item.enabled ? "" : " item--off"));
      var keyClass = item.number == null ? "key key--none" : item.number > 12 ? "key key--extra" : "key";
      row.appendChild(el("span", keyClass, item.number != null ? String(item.number) : "0"));
      row.appendChild(labelNode(item.label, view.query));
      if (item.submenu) row.appendChild(el("span", "mark", "›"));
      if (item.enabled) row.addEventListener("click", function () { invoke("menu_pick", { index: index }); });
      // Right click: on a phrase how to use it (insert, insert + Enter, only
      // copy) or edit it; on a list only edit.
      if (item.enabled && (item.submenu || item.detail)) {
        row.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          showModes(index, event, !item.text);
        });
      }
      rows.appendChild(row);
      items.push(row);
    });
    if (!view.items.some(function (item) { return !item.search; })) rows.appendChild(el("div", "empty", view.empty));
    highlight = -1;
  }

  /** A submenu's list taller than the menu: as many columns side by side as
   *  it takes to show every name (the side widens; the window follows through
   *  the ResizeObserver → `layout`). Any other tip: one column. */
  function splitIntoColumns(room) {
    var side = tip.parentNode;
    side.style.width = "";
    tip.style.columnCount = "";
    tip.style.height = "";
    tip.classList.remove("tip--cols");
    var columnWidth = side.clientWidth;
    tipColumn = columnWidth;
    if (!tip.classList.contains("tip--list") || tip.scrollHeight <= room + 1) return;
    // No more columns than the room beside the list holds (the gap to the list included).
    var most = Math.min(MAX_TIP_COLUMNS, Math.floor((sideRoom - 8) / columnWidth));
    if (most < 2) return;
    tip.classList.add("tip--cols");
    tip.style.height = room + "px";
    for (var columns = 2; columns <= most; columns++) {
      tip.style.columnCount = columns;
      side.style.width = columns * columnWidth + "px";
      // Columns that still do not fit overflow sideways.
      if (tip.scrollWidth <= tip.clientWidth + 1) break;
    }
    // Balanced columns need no more height than their tallest one.
    tip.style.height = "";
  }

  var noteBox = null;

  function hideNote() {
    if (noteBox) noteBox.remove();
    noteBox = null;
  }

  /** A name's description in the tip: a box under the name (over it when there
   *  is no room below), kept inside the window. */
  function showNote(entry, text) {
    hideNote();
    noteBox = el("div", "note", text);
    root.appendChild(noteBox);
    var box = root.getBoundingClientRect();
    var at = entry.getBoundingClientRect();
    noteBox.style.width = Math.max(at.width, 220) + "px";
    var left = Math.min(at.left - box.left, box.width - noteBox.offsetWidth - 4);
    var top = at.bottom - box.top + 2;
    if (top + noteBox.offsetHeight > box.height - 4) top = at.top - box.top - noteBox.offsetHeight - 2;
    noteBox.style.left = Math.max(4, left) + "px";
    noteBox.style.top = Math.max(4, top) + "px";
  }

  function showTip(index) {
    hideNote();
    var item = view.items[index];
    var row = items[index];
    clearTimeout(fullTimer);
    tip.classList.remove("tip--full");
    if (!item || !row || item.search) { tip.style.visibility = "hidden"; return; }
    tip.style.visibility = "";
    tip.textContent = "";
    tip.classList.toggle("tip--list", !!(item.children && item.children.length));
    if (item.children && item.children.length) {
      // A submenu: what it holds, one name per line.
      // Each name is a button: it takes that item without opening the submenu first.
      var tipGroup = null;
      var block = tip;
      item.children.forEach(function (name, child) {
        // A link to another menu: that menu's blocks, each a heading over its
        // names, kept whole in one column.
        var childGroup = (item.childGroups && item.childGroups[child]) || null;
        if (childGroup !== tipGroup) {
          tipGroup = childGroup;
          block = tip;
          if (tipGroup) {
            block = tip.appendChild(el("div", "tip__block"));
            block.appendChild(el("div", "group", tipGroup));
          }
        }
        // A line between the submenu's items (the only nameless entry).
        if (name === "") { block.appendChild(el("div", "line")); return; }
        var entry = el("button", "tip__item", name);
        entry.type = "button";
        // What it does (its description), in a box beside the name while the pointer is on it.
        var note = item.childNotes && item.childNotes[child];
        if (note) {
          entry.addEventListener("mouseenter", function () { showNote(entry, note); });
          entry.addEventListener("mouseleave", hideNote);
        }
        entry.addEventListener("click", function () { invoke("menu_pick_child", { index: index, child: child }); });
        // The same right-click choices as on a row of the list.
        entry.addEventListener("contextmenu", function (event) {
          event.preventDefault();
          showModes(index, event, !(item.textChildren && item.textChildren[child]), child);
        });
        block.appendChild(entry);
      });
    } else {
      // A phrase: what it does (its description) over what it sends.
      if (item.note) tip.appendChild(el("div", "tip__note", item.note));
      tip.appendChild(document.createTextNode(item.detail || item.label));
    }
    tip.classList.remove("tip--fresh");
    void tip.offsetWidth;
    tip.classList.add("tip--fresh");
    var room = tip.parentNode.clientHeight;
    tip.style.maxHeight = room + "px";
    splitIntoColumns(room);
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
    var asked = view;
    tauri.invoke("menu_full_text", { index: index }).then(function (text) {
      // Still the same menu (not reopened or redrawn) on the same row.
      if (view !== asked || highlight !== index || !text) return;
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

  /** The right-click choices, over the list at the pointer (kept inside the window);
   *  `child`: a name in the tip of the submenu at `index`. */
  function showModes(index, event, listOnly, child) {
    hideModes();
    if (!items[index] || !view.pickModes || view.pickModes.length < 4) return;
    modes = el("div", "modes");
    var inTip = child != null;
    (listOnly ? ["edit"] : ["run", "enter", "copy", "edit"]).forEach(function (mode) {
      var button = el("button", "tip__mode", view.pickModes[["run", "enter", "copy", "edit"].indexOf(mode)]);
      button.addEventListener("click", function () {
        hideModes();
        if (mode === "edit") invoke("menu_edit", inTip ? { index: index, child: child } : { index: index });
        else if (inTip) invoke("menu_pick_child", { index: index, child: child, mode: mode });
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
    if (items[index]) {
      items[index].classList.add("item--on");
      items[index].scrollIntoView({ block: "nearest" });
    }
    showTip(index);
  }

  // Sent in physical pixels at the page's own scale, and again whenever the
  // content or the scale changes (a new window moved onto another monitor).
  function layout() {
    if (!view) return;
    var dpr = window.devicePixelRatio || 1;
    root.style.setProperty("--menu-max-height", view.maxHeight / dpr + "px");
    if (items[highlight]) {
      items[highlight].scrollIntoView({ block: "nearest" });
      showTip(highlight);
    }
    var box = root.getBoundingClientRect();
    var sideWidth = tip ? tip.parentNode.getBoundingClientRect().width : 0;
    var size = {
      generation: view.generation,
      width: Math.ceil(box.width * dpr),
      height: Math.ceil(box.height * dpr),
      side: Math.ceil(sideWidth * dpr),
      sideMax: Math.ceil((tipColumn || sideWidth) * MAX_TIP_COLUMNS * dpr),
      sideLeft: sideLeft,
    };
    var key = JSON.stringify(size);
    if (key !== lastLayout) {
      lastLayout = key;
      var generation = view.generation;
      invoke("menu_layout", size).then(function (placement) {
        if (!placement || !view || view.generation !== generation) return;
        var room = placement.room / dpr;
        if (placement.sideLeft === sideLeft && room === sideRoom) return;
        sideLeft = placement.sideLeft;
        sideRoom = room;
        root.classList.toggle("menu--side-left", sideLeft);
        layout();
      });
    }
  }

  function render(next) {
    var fresh = !view || next.generation !== view.generation;
    view = next;
    if (fresh) {
      // A new menu is placed anew.
      sideLeft = false;
      sideRoom = Infinity;
      root.classList.remove("menu--side-left");
      buildFrame();
      search.placeholder = view.placeholder;
    }
    if (search.value !== view.query) search.value = view.query;
    scope.hidden = !view.hasOthers;
    scope.textContent = view.searchAll ? view.scopeAll : view.scopeThis;
    scope.classList.toggle("scope--this", !view.searchAll);
    var key = JSON.stringify([view.generation, view.title, view.parent, view.query, view.items]);
    if (key !== levelKey) {
      levelKey = key;
      hideModes();
      buildRows();
      layout();
    }
    setHighlight(view.highlight);
    // The box may have moved among the rows: focusing it must not scroll the list away from the highlight.
    search.focus({ preventScroll: true });
  }

  /** A cheat sheet's keys: ↑↓ a row, ←→ a cell, Tab the other layer, Esc
   *  clears the query first. False: not a grid key. */
  function onGridKey(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") invoke("menu_wheel", { down: event.key === "ArrowDown", row: true });
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") invoke("menu_wheel", { down: event.key === "ArrowRight" });
    else if (event.key === "Tab") invoke("menu_sheet_layer");
    else if (event.key === "Escape" && view.query) invoke("menu_search", { query: "" });
    else return false;
    return true;
  }

  function onKey(event) {
    var handled = true;
    if (view && view.grid && onGridKey(event)) handled = true;
    else if (event.key === "ArrowDown") invoke("menu_wheel", { down: true });
    else if (event.key === "ArrowUp") invoke("menu_wheel", { down: false });
    else if (event.key === "Enter") invoke("menu_confirm");
    else if (event.key === "Escape") invoke("menu_close");
    // Tab never moves the focus out of the box (the keys stay with the menu).
    else if (event.key === "Tab") { if (view.hasOthers) toggleScope(); }
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
    if (index >= 0 && index !== highlight && !row.classList.contains("item--off") && !row.classList.contains("cell--dim")) {
      invoke("menu_hover", { index: index });
    }
  });

  window.addEventListener("resize", layout);
  if (window.ResizeObserver) new ResizeObserver(layout).observe(root);
  // Never the browser's own menu (back, reload, print…); the search box keeps cut / copy / paste.
  document.addEventListener("contextmenu", function (event) {
    if (event.target !== search) event.preventDefault();
  });
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
