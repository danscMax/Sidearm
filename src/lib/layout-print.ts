// The whole layout as one printable HTML page (Print / Save as PDF in the
// browser): per profile and mouse, each layer with assignments — the 12 side
// buttons as the mouse's 3 × 4 grid, the other buttons as a list — every press
// pattern of a button in its cell.

import type { AppConfig, Binding, ControlId, Layer } from "./config";
import { gestureOf } from "./config-editing";
import { deviceLayout, layoutControlId } from "./devices";
import i18n from "../i18n";
import { displayNameForControlId, labelForLayer } from "./labels";

const LAYERS: Layer[] = ["standard", "hypershift", "hypershift2", "hypershiftBoth"];
const MARK = { press: "", longPress: "⌛ ", doublePress: "2× ", triplePress: "3× " } as const;
const ORDER = { press: 0, longPress: 1, doublePress: 2, triplePress: 3 } as const;

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A button's cell: its press patterns, the plain press first. */
function cell(bindings: Binding[]): string {
  return [...bindings]
    .sort((a, b) => ORDER[gestureOf(a.triggerMode)] - ORDER[gestureOf(b.triggerMode)])
    .map((b) => {
      const gesture = gestureOf(b.triggerMode);
      return `<div class="${gesture === "press" ? "main" : "extra"}">${MARK[gesture]}${escape(b.label)}</div>`;
    })
    .join("");
}

/** The page, with its title and the date it was made. */
export function layoutHtml(config: AppConfig, made: Date): string {
  const mice = config.devices.filter((device) => device.builtin && deviceLayout(device.id));
  const deviceOf = new Map(config.physicalControls.map((control) => [control.id, control.deviceId]));
  const sections: string[] = [];
  for (const profile of [...config.profiles].sort((a, b) => b.priority - a.priority)) {
    for (const mouse of mice) {
      const layers: string[] = [];
      for (const layer of LAYERS) {
        const bindings = config.bindings.filter((b) => b.enabled && b.profileId === profile.id && b.layer === layer && deviceOf.get(b.controlId) === mouse.id);
        if (bindings.length === 0) continue;
        const byControl = new Map<ControlId, Binding[]>();
        for (const b of bindings) byControl.set(b.controlId, [...(byControl.get(b.controlId) ?? []), b]);
        const thumbs = Array.from({ length: 12 }, (_, i) => `thumb_${String(i + 1).padStart(2, "0")}`);
        const thumbOf = new Map([...byControl.keys()].map((id) => [layoutControlId(id), id]));
        const grid = thumbs.map((place, i) => {
          const id = thumbOf.get(place);
          return `<div class="key"><span class="n">${i + 1}</span>${id ? cell(byControl.get(id)!) : `<div class="none">—</div>`}</div>`;
        }).join("");
        const others = [...byControl.entries()]
          .filter(([id]) => !thumbs.includes(layoutControlId(id)))
          .map(([id, list]) => `<tr><th>${escape(displayNameForControlId(id))}</th><td>${cell(list)}</td></tr>`)
          .join("");
        layers.push(`<section class="layer"><h3>${escape(labelForLayer(layer))}</h3><div class="grid">${grid}</div>${others ? `<table>${others}</table>` : ""}</section>`);
      }
      if (layers.length) sections.push(`<article><h2>${escape(profile.name)} · ${escape(mouse.name)}</h2>${layers.join("")}</article>`);
    }
  }
  const title = i18n.t("print.title");
  return `<!doctype html>
<html lang="${i18n.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { --text: #1d2318; --muted: #6a7363; --line: #d9dfd2; --accent: #4f7a1e; --soft: #f3f6ef; }
  body { margin: 24px; background: #fff; color: var(--text); font: 13px/1.4 "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .made { color: var(--muted); margin: 0 0 20px; }
  article { margin: 0 0 28px; break-inside: avoid-page; }
  article + article { break-before: page; }
  h2 { font-size: 16px; margin: 0 0 10px; border-bottom: 2px solid var(--accent); padding-bottom: 4px; }
  .layer { margin: 0 0 16px; break-inside: avoid; }
  h3 { font-size: 13px; margin: 0 0 6px; color: var(--accent); text-transform: uppercase; letter-spacing: .04em; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; max-width: 720px; }
  .key { position: relative; min-height: 44px; padding: 6px 8px 6px 30px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); }
  .n { position: absolute; left: 8px; top: 6px; font-weight: 700; color: var(--accent); }
  .main { font-weight: 600; }
  .extra { color: var(--muted); font-size: 12px; }
  .none { color: var(--muted); }
  table { margin-top: 8px; border-collapse: collapse; max-width: 720px; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  th { width: 34%; font-weight: 500; color: var(--muted); }
</style></head><body>
<h1>${escape(title)}</h1>
<p class="made">${escape(i18n.t("print.made", { date: made.toLocaleString(i18n.language) }))} · ${escape(i18n.t("print.legend"))}</p>
${sections.join("\n")}
</body></html>
`;
}
