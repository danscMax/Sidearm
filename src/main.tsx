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
// cut / copy / paste menu, and a dev build keeps it everywhere (Inspect).
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement | null;
  const editable = target?.closest("input, textarea, [contenteditable='true']");
  if (!editable && !import.meta.env.DEV) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
