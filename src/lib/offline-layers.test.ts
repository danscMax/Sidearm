import { describe, expect, it } from "vitest";
import { layerCopy } from "./constants";
import { deviceLayers } from "./devices";
import { expectedEncodedKeyForControl, seedExpectedEncoderMapping } from "./config-editing";
import { createVerificationSession } from "./verification-session";
import { labelForLayer } from "./labels";
import { filterPaletteResults } from "./command-palette-helpers";
import { makeConfig } from "./test-fixtures";

describe.each(["offline", "offlineHypershift"] as const)("offline layer boundaries: %s", (layer) => {
  it("has a localized name, but is absent from live layer lists and signal verification", () => {
    const config = makeConfig();
    expect(labelForLayer(layer)).toBe(layer === "offline" ? "Без Sidearm" : "Без Sidearm · HyperShift");
    expect(layerCopy.map((item) => item.value)).not.toContain(layer);
    expect(deviceLayers(config, "p1", "razer-naga", layer)).not.toContain(layer);
    expect(expectedEncodedKeyForControl("thumb_01", layer)).toBeNull();
    expect(seedExpectedEncoderMapping(config, layer, config.physicalControls[0])).toBe(config);
    expect(createVerificationSession(config, layer, "p1", "thumb_01", "all")).toBeNull();
  });

  it("does not open memory-only bindings through live assignment search", () => {
    const result = filterPaletteResults("Copy", { commands: [], snippets: [], actionsById: new Map(), bindings: [
      { id: "b", profileId: "p1", layer, controlId: "thumb_01", label: "Copy", actionId: "a", enabled: true },
    ] });
    expect(result.bindings).toEqual([]);
  });
});
