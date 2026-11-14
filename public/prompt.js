// The input fields of a phrase with {input:name} tags (input_prompt.rs).
// Enter moves to the next field and, on the last one, inserts the phrase;
// Esc or a click elsewhere sends nothing. Rust sizes and places the window.
(function () {
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  var root = document.getElementById("prompt");
  var view = null;
  var inputs = [];

  function invoke(command, args) { return tauri.invoke(command, args || {}); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function submit() {
    var values = {};
    view.fields.forEach(function (name, index) { values[name] = inputs[index].value; });
    invoke("prompt_submit", { generation: view.generation, values: values });
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      invoke("prompt_cancel", { generation: view.generation });
    } else if (event.key === "Enter") {
      event.preventDefault();
      var index = inputs.indexOf(event.target);
      if (index >= 0 && index < inputs.length - 1) inputs[index + 1].focus();
      else submit();
    }
  }

  function render(next) {
    view = next;
    inputs = [];
    root.textContent = "";
    root.appendChild(el("div", "title", view.title));
    view.fields.forEach(function (name) {
      var field = el("label", "field");
      field.appendChild(el("span", "name", name));
      var input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.addEventListener("keydown", onKey);
      field.appendChild(input);
      root.appendChild(field);
      inputs.push(input);
    });
    root.appendChild(el("div", "hint", view.hint));
    var dpr = window.devicePixelRatio || 1;
    var box = root.getBoundingClientRect();
    // The card plus its margin, in physical pixels.
    invoke("prompt_layout", { generation: view.generation, width: Math.ceil((box.width + 8) * dpr), height: Math.ceil((box.height + 8) * dpr) });
    setTimeout(function () { if (inputs[0]) inputs[0].focus(); }, 0);
  }

  // Never the browser's own menu (back, reload, print…); the fields keep cut / copy / paste.
  document.addEventListener("contextmenu", function (event) {
    if (!(event.target.closest && event.target.closest("input, textarea"))) event.preventDefault();
  });

  // Another window in front: the question goes (a late blur of an answered one is ignored by Rust).
  window.addEventListener("blur", function () {
    if (view) invoke("prompt_cancel", { generation: view.generation });
  });

  invoke("plugin:event|listen", {
    event: "prompt-show",
    target: { kind: "Any" },
    handler: tauri.transformCallback(function (event) { render(event.payload || {}); }),
  }).then(function () { invoke("prompt_ready"); });
})();
