import { describe, expect, it } from "vitest";
import { makeConfig } from "./test-fixtures";
import { ensurePlaceholderBinding, findBinding, gestureOf, upsertBinding } from "./config-editing";

describe("press patterns on one button", () => {
  it("keeps one binding per pattern, each found by its own gesture", () => {
    const config = makeConfig();
    const control = config.physicalControls.find((c) => c.id === "thumb_01")!;
    let next = ensurePlaceholderBinding(config, "p1", "standard", control).config;
    const long = ensurePlaceholderBinding(next, "p1", "standard", control, "longPress");
    next = long.config;
    const press = findBinding(next, "p1", "standard", "thumb_01");
    const held = findBinding(next, "p1", "standard", "thumb_01", "longPress");
    expect(press).not.toBeNull();
    expect(held?.id).toBe(long.bindingId);
    expect(held?.id).not.toBe(press?.id);
    expect(gestureOf(held?.triggerMode)).toBe("longPress");
    expect(findBinding(next, "p1", "standard", "thumb_01", "doublePress")).toBeNull();

    // Saving the long press replaces only the long press.
    const relabeled = upsertBinding(next, { ...held!, id: "other-id", label: "Long" });
    expect(relabeled.bindings.filter((b) => b.controlId === "thumb_01" && b.profileId === "p1")).toHaveLength(2);
    expect(findBinding(relabeled, "p1", "standard", "thumb_01", "longPress")?.label).toBe("Long");
    expect(findBinding(relabeled, "p1", "standard", "thumb_01")?.id).toBe(press?.id);
  });

  it("treats hold and chord as variants of the plain press", () => {
    expect(gestureOf(undefined)).toBe("press");
    expect(gestureOf("hold")).toBe("press");
    expect(gestureOf("chord")).toBe("press");
    expect(gestureOf("triplePress")).toBe("triplePress");
  });
});
