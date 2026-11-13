import { describe, expect, it } from "vitest";
import { canonicalPrimaryKey, primaryKeyCode } from "./key-names";

describe("backend primary-key contract", () => {
  it.each([["c", 0x43], ["с", 0x43], ["ё", 0xC0], ["Return", 0x0D], ["num_lock", 0x90],
    ["F0013", 0x7C], ["VK_96", 0x60], ["VK_65535", 0xFFFF]] as const)("parses %s as VK %s", (key, vk) => {
    expect(primaryKeyCode(key)).toBe(vk);
  });

  it.each(["ı", "ſ", "Ђ", "!", "+", "_", "F25", "VK_0", "VK_65536", "toString"])("rejects unsupported backend key %s", (key) => {
    expect(primaryKeyCode(key)).toBeNull();
  });

  it("keeps canonical conflict signatures stable across aliases", () => {
    expect(canonicalPrimaryKey(" Return ")).toBe("ENTER");
    expect(canonicalPrimaryKey("ESCAPE")).toBe("ESC");
    expect(canonicalPrimaryKey("VK_65")).toBe("A");
  });
});
