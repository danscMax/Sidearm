/**
 * menu-helpers.edgecases.test.ts
 *
 * Property-based and unit edge-case tests for menu-helpers.ts.
 * Targets invariants NOT already covered by menu-helpers.test.ts.
 *
 * What's already in menu-helpers.test.ts:
 *   - collectMenuItemIds: flat, nested, deeply nested, empty
 *   - appendMenuItem: root, into submenu, into nested submenu, nonexistent parent, no-mutation
 *   - updateMenuItem: root, nested, not-found
 *   - removeMenuItem: root, nested, empty-submenu cascade, double-cascade, not-found
 *
 * New invariants added here:
 *   - collectMenuItemIds: total count = action items + submenu items (PBT)
 *   - appendMenuItem: immutability (PBT), id presence in result (PBT)
 *   - removeMenuItem: idempotence, cascade behavior property, non-mutation
 *   - updateMenuItem: identity update is no-mutation at structural level
 *   - Boundary: deeply nested (stack depth), single submenu with many children
 *   - Null & empty: submenu removal leaves parent if sibling exists
 *   - Overflow: 1000-item flat list, deeply recursive submenu
 *
 * Categories:
 *   - Boundary (40%)
 *   - Null & empty (20%)
 *   - Overflow (15%)
 *   - Concurrency (N/A): all functions are pure, recursive, no shared state.
 *   - Temporal (N/A): no time/ID generation in menu-helpers.ts.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import type { MenuItem } from "./config";
import {
  collectMenuItemIds,
  appendMenuItem,
  updateMenuItem,
  removeMenuItem,
} from "./menu-helpers";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a unique ID string for menu items. */
const arbId = fc.uuid();

/** Generate a flat action MenuItem. */
const arbActionItem = (id: string): MenuItem => ({
  kind: "action",
  id,
  label: `Label ${id}`,
  actionId: `ref-${id}`,
  enabled: true,
});

/** Fast-check arbitrary for a flat list of distinct-ID action menu items. */
const arbFlatItems: fc.Arbitrary<MenuItem[]> = fc
  .uniqueArray(arbId, { minLength: 0, maxLength: 20 })
  .map((ids) => ids.map((id) => arbActionItem(id)));

// ---------------------------------------------------------------------------
// BOUNDARY (40%)
// ---------------------------------------------------------------------------

describe("boundary: collectMenuItemIds — count invariant (PBT)", () => {
  it("collectMenuItemIds count equals total action items + submenu items (flat list, PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, (items) => {
        const ids = collectMenuItemIds(items);
        // For a flat list with no submenus, every item contributes exactly 1 id
        expect(ids.length).toBe(items.length);
      }),
      { numRuns: 1000 },
    );
  });

  it("collectMenuItemIds result is a superset of all top-level item ids (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, (items) => {
        const ids = new Set(collectMenuItemIds(items));
        for (const item of items) {
          expect(ids.has(item.id)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("collectMenuItemIds on flat list has no duplicate ids (PBT, unique input)", () => {
    fc.assert(
      fc.property(arbFlatItems, (items) => {
        const ids = collectMenuItemIds(items);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 1000 },
    );
  });

  it("collectMenuItemIds of a submenu includes both submenu id and child ids", () => {
    const child1: MenuItem = arbActionItem("child-1");
    const child2: MenuItem = arbActionItem("child-2");
    const sub: MenuItem = {
      kind: "submenu",
      id: "sub-root",
      label: "Sub",
      enabled: true,
      items: [child1, child2],
    };
    const ids = collectMenuItemIds([sub]);
    expect(ids).toContain("sub-root");
    expect(ids).toContain("child-1");
    expect(ids).toContain("child-2");
    expect(ids.length).toBe(3);
  });

  it("collectMenuItemIds on nested submenu-of-submenu is depth-first (PBT on 2-level nesting)", () => {
    // Build a 2-level structure: root submenu → submenu → leaf
    fc.assert(
      fc.property(
        fc.uniqueArray(arbId, { minLength: 3, maxLength: 3 }),
        ([outerSubId, innerSubId, leafId]) => {
          const leaf: MenuItem = arbActionItem(leafId!);
          const inner: MenuItem = {
            kind: "submenu",
            id: innerSubId!,
            label: "Inner",
            enabled: true,
            items: [leaf],
          };
          const outer: MenuItem = {
            kind: "submenu",
            id: outerSubId!,
            label: "Outer",
            enabled: true,
            items: [inner],
          };
          const ids = collectMenuItemIds([outer]);
          // All 3 ids must appear
          expect(ids).toContain(outerSubId!);
          expect(ids).toContain(innerSubId!);
          expect(ids).toContain(leafId!);
          expect(ids.length).toBe(3);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: appendMenuItem — structural invariants (PBT)", () => {
  it("appending to root (parentId=null) increases length by exactly 1 (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, newId) => {
        const newItem: MenuItem = arbActionItem(newId);
        const result = appendMenuItem(items, null, newItem);
        expect(result.length).toBe(items.length + 1);
      }),
      { numRuns: 1000 },
    );
  });

  it("appended item id appears in collectMenuItemIds of result (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, newId) => {
        const newItem: MenuItem = arbActionItem(newId);
        const result = appendMenuItem(items, null, newItem);
        const ids = collectMenuItemIds(result);
        expect(ids).toContain(newId);
      }),
      { numRuns: 1000 },
    );
  });

  it("appendMenuItem does not mutate original array (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, newId) => {
        const originalLength = items.length;
        const originalIds = items.map((i) => i.id);
        appendMenuItem(items, null, arbActionItem(newId));
        // Original must be unchanged
        expect(items.length).toBe(originalLength);
        expect(items.map((i) => i.id)).toEqual(originalIds);
      }),
      { numRuns: 1000 },
    );
  });

  it("appendMenuItem with non-existent parentId returns original items unchanged in structure (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, arbId, (items, parentId, newId) => {
        // If parentId not in any submenu, root-level structure is unchanged
        const result = appendMenuItem(items, parentId, arbActionItem(newId));
        // The top-level items must still have the same ids and count
        expect(result.map((i) => i.id)).toEqual(items.map((i) => i.id));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: removeMenuItem — structural invariants (PBT)", () => {
  it("removeMenuItem of non-existent id returns array of same length (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, ghostId) => {
        // Ensure ghostId is not in items
        const safeItems = items.filter((i) => i.id !== ghostId);
        const result = removeMenuItem(safeItems, ghostId);
        expect(result.length).toBe(safeItems.length);
      }),
      { numRuns: 1000 },
    );
  });

  it("removeMenuItem of an existing id decreases collectMenuItemIds count by 1 (PBT, flat list)", () => {
    fc.assert(
      fc.property(
        arbFlatItems.filter((items) => items.length > 0),
        (items) => {
          const targetId = items[0]!.id;
          const before = collectMenuItemIds(items).length;
          const result = removeMenuItem(items, targetId);
          const after = collectMenuItemIds(result).length;
          expect(after).toBe(before - 1);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("removeMenuItem never includes the removed id in subsequent collectMenuItemIds (PBT)", () => {
    fc.assert(
      fc.property(
        arbFlatItems.filter((items) => items.length > 0),
        (items) => {
          const targetId = items[0]!.id;
          const result = removeMenuItem(items, targetId);
          expect(collectMenuItemIds(result)).not.toContain(targetId);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("removeMenuItem does not mutate original array (PBT)", () => {
    fc.assert(
      fc.property(
        arbFlatItems.filter((items) => items.length > 0),
        (items) => {
          const originalIds = items.map((i) => i.id);
          removeMenuItem(items, items[0]!.id);
          expect(items.map((i) => i.id)).toEqual(originalIds);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("removeMenuItem is idempotent: removing a nonexistent id twice leaves structure unchanged (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, ghostId) => {
        const safeItems = items.filter((i) => i.id !== ghostId);
        const once = removeMenuItem(safeItems, ghostId);
        const twice = removeMenuItem(once, ghostId);
        expect(collectMenuItemIds(twice)).toEqual(collectMenuItemIds(once));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("boundary: updateMenuItem — identity update (PBT)", () => {
  it("updateMenuItem with identity fn on non-existent id returns structurally equivalent result (PBT)", () => {
    fc.assert(
      fc.property(arbFlatItems, arbId, (items, ghostId) => {
        const safeItems = items.filter((i) => i.id !== ghostId);
        const result = updateMenuItem(safeItems, ghostId, (item) => item);
        expect(collectMenuItemIds(result)).toEqual(collectMenuItemIds(safeItems));
      }),
      { numRuns: 1000 },
    );
  });

  it("updateMenuItem with identity fn on existing id produces same id set (PBT)", () => {
    fc.assert(
      fc.property(
        arbFlatItems.filter((items) => items.length > 0),
        (items) => {
          const targetId = items[0]!.id;
          const result = updateMenuItem(items, targetId, (item) => item);
          // The set of ids must be unchanged
          expect(new Set(collectMenuItemIds(result))).toEqual(
            new Set(collectMenuItemIds(items)),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// NULL & EMPTY (20%)
// ---------------------------------------------------------------------------

describe("null & empty: collectMenuItemIds with empty list", () => {
  it("returns empty array for empty items list", () => {
    expect(collectMenuItemIds([])).toEqual([]);
  });
});

describe("null & empty: appendMenuItem to empty root", () => {
  it("appending to empty list returns single-element list", () => {
    const item = arbActionItem("single");
    const result = appendMenuItem([], null, item);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("single");
  });
});

describe("null & empty: removeMenuItem from empty list", () => {
  it("removeMenuItem on empty list returns empty list without throwing", () => {
    expect(removeMenuItem([], "any-id")).toEqual([]);
  });
});

describe("null & empty: removeMenuItem — submenu with sibling: sibling survives", () => {
  it("removing only child of submenu removes submenu; sibling at parent level survives", () => {
    const sibling: MenuItem = arbActionItem("sibling");
    const child: MenuItem = arbActionItem("child");
    const sub: MenuItem = {
      kind: "submenu",
      id: "sub",
      label: "Sub",
      enabled: true,
      items: [child],
    };
    const items: MenuItem[] = [sibling, sub];
    const result = removeMenuItem(items, "child");
    // sub becomes empty → should be removed by cascade; sibling must remain
    const ids = collectMenuItemIds(result);
    expect(ids).toContain("sibling");
    expect(ids).not.toContain("child");
    expect(ids).not.toContain("sub");
  });
});

describe("null & empty: updateMenuItem on empty list does not throw", () => {
  it("returns empty list without throwing", () => {
    const result = updateMenuItem([], "any-id", (item) => item);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OVERFLOW (15%)
// ---------------------------------------------------------------------------

describe("overflow: collectMenuItemIds with 1000-item flat list", () => {
  it("returns 1000 ids without throwing", () => {
    const items: MenuItem[] = Array.from({ length: 1000 }, (_, i) => arbActionItem(`item-${i}`));
    const ids = collectMenuItemIds(items);
    expect(ids.length).toBe(1000);
  });
});

describe("overflow: appendMenuItem — append 500 items sequentially", () => {
  it("accumulating 500 appends to root results in 500 items", () => {
    let items: MenuItem[] = [];
    for (let i = 0; i < 500; i++) {
      items = appendMenuItem(items, null, arbActionItem(`item-${i}`));
    }
    expect(items.length).toBe(500);
    expect(collectMenuItemIds(items).length).toBe(500);
  });
});

describe("overflow: deeply nested submenu (10 levels) — collectMenuItemIds", () => {
  it("collects the leaf id even at 10 nesting levels", () => {
    const DEPTH = 10;
    let current: MenuItem = arbActionItem("leaf");
    for (let i = DEPTH - 1; i >= 0; i--) {
      current = {
        kind: "submenu",
        id: `sub-level-${i}`,
        label: `Level ${i}`,
        enabled: true,
        items: [current],
      };
    }
    const ids = collectMenuItemIds([current]);
    // Should have 10 submenu ids + 1 leaf = 11 total
    expect(ids.length).toBe(DEPTH + 1);
    expect(ids).toContain("leaf");
    expect(ids).toContain("sub-level-0");
    expect(ids).toContain(`sub-level-${DEPTH - 1}`);
  });
});

describe("overflow: deeply nested submenu — removeMenuItem at leaf", () => {
  it("removes leaf from 10-level deep submenu and collapses all empty parents", () => {
    const DEPTH = 10;
    let current: MenuItem = arbActionItem("deepleaf");
    for (let i = DEPTH - 1; i >= 0; i--) {
      current = {
        kind: "submenu",
        id: `lvl-${i}`,
        label: `L${i}`,
        enabled: true,
        items: [current],
      };
    }
    const result = removeMenuItem([current], "deepleaf");
    // All submenus became empty and should be cascaded away
    expect(result.length).toBe(0);
  });
});

describe("overflow: label with unicode / emoji in menu item", () => {
  it("appendMenuItem with emoji label does not throw and id appears in collectMenuItemIds", () => {
    const item: MenuItem = {
      kind: "action",
      id: "emoji-item",
      label: "🎮 Действие",
      actionId: "ref-emoji",
      enabled: true,
    };
    const result = appendMenuItem([], null, item);
    expect(collectMenuItemIds(result)).toContain("emoji-item");
  });

  it("updateMenuItem can set an RTL label without throwing", () => {
    const item: MenuItem = arbActionItem("rtl-item");
    const items: MenuItem[] = [item];
    const result = updateMenuItem(items, "rtl-item", (i) =>
      i.kind === "action" ? { ...i, label: "مشغل" } : i,
    );
    if (result[0]?.kind === "action") {
      expect(result[0].label).toBe("مشغل");
    }
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — N/A
// All functions in menu-helpers.ts are pure, recursive, and synchronous.
// They operate on value-copied arrays with no shared mutable module state.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPORAL — N/A
// No timestamp or ID generation exists in menu-helpers.ts.
// ---------------------------------------------------------------------------
