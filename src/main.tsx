import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { setKeyRecording } from "./lib/backend";

// A recording left on by a reload (the page went away mid-capture) is over.
void setKeyRecording(false).catch(() => {});

// A right click is never the browser's own menu (Back, Reload, Print…): the
// app's own menus handle it where they exist. Text fields keep the native
// cut / copy / paste menu; a dev build shows it with Shift held (Inspect).
document.addEventListener("contextmenu", (event) => {
  // Dev + Shift: the browser menu, before the app's own menus see the click
  // (capture phase: React's handlers sit below the document and would open theirs).
  if (import.meta.env.DEV && event.shiftKey) {
    event.stopPropagation();
    return;
  }
  const target = event.target as HTMLElement | null;
  if (!target?.closest("input, textarea, [contenteditable='true']")) event.preventDefault();
}, true);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
