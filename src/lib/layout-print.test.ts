import { describe, expect, it } from "vitest";
import type { Action, Binding } from "./config";
import { layoutHtml } from "./layout-print";
import { makeConfig } from "./test-fixtures";

describe("layoutHtml", () => {
  it("draws each profile's side buttons as a grid with every press pattern, escaped", () => {
    const action = { id: "a", type: "shortcut", displayName: "A", payload: { key: "A", ctrl: false, shift: false, alt: false, win: false } } as Action;
    const bind = (id: string, controlId: string, label: string, extra: Partial<Binding> = {}): Binding =>
      ({ id, profileId: "p1", layer: "standard", controlId, label, actionId: "a", enabled: true, ...extra });
    const config = makeConfig({ actions: [action], bindings: [bind("b1", "thumb_01", "<Copy>"), bind("b2", "thumb_01", "Cut", { triggerMode: "longPress" }), bind("b3", "mouse_4", "Back")] });
    const html = layoutHtml(config, new Date(2026, 10, 13));
    expect(html).toContain("&lt;Copy&gt;");
    expect(html).toMatch(/<b>[^<]+:<\/b> Cut/);
    expect(html.match(/class="key"/g)).toHaveLength(12);
    expect(html).toContain("<table>");
  });
});
