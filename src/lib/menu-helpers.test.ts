import { describe, it, expect } from "vitest";
import type { MenuItem } from "./config";
import {
  collectMenuItemIds,
  appendMenuItem,
  updateMenuItem,
  removeMenuItem,
} from "./menu-helpers";

// ---------------------------------------------------------------------------
// collectMenuItemIds
// ---------------------------------------------------------------------------

describe("collectMenuItemIds", () => {
  it("collects ids from a flat list", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
    ];
    expect(collectMenuItemIds(items)).toEqual(["a", "b"]);
  });

  it("collects ids from nested submenus", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
        ],
      },
    ];
    expect(collectMenuItemIds(items)).toEqual(["a", "sub", "b"]);
  });

  it("collects ids from deeply nested submenus", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [
              { kind: "action", id: "deep", label: "Deep", actionRef: "r1", enabled: true },
            ],
          },
        ],
      },
    ];
    expect(collectMenuItemIds(items)).toEqual(["s1", "s2", "deep"]);
  });

  it("returns empty array for empty items", () => {
    expect(collectMenuItemIds([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendMenuItem
// ---------------------------------------------------------------------------

describe("appendMenuItem", () => {
  const newItem: MenuItem = {
    kind: "action",
    id: "new",
    label: "New",
    actionRef: "r1",
    enabled: true,
  };

  it("appends to root level when parentId is null", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = appendMenuItem(items, null, newItem);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe("new");
  });

  it("appends into a submenu by parentId", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [{ kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true }],
      },
    ];
    const result = appendMenuItem(items, "sub", newItem);
    if (result[0].kind === "submenu") {
      expect(result[0].items).toHaveLength(2);
      expect(result[0].items[1].id).toBe("new");
    }
  });

  it("appends into a nested submenu", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [],
          },
        ],
      },
    ];
    const result = appendMenuItem(items, "s2", newItem);
    if (result[0].kind === "submenu" && result[0].items[0].kind === "submenu") {
      expect(result[0].items[0].items).toHaveLength(1);
      expect(result[0].items[0].items[0].id).toBe("new");
    }
  });

  it("does not crash when parentId does not exist", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = appendMenuItem(items, "nonexistent", newItem);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("does not mutate original items", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const original = [...items];
    appendMenuItem(items, null, newItem);
    expect(items).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// updateMenuItem
// ---------------------------------------------------------------------------

describe("updateMenuItem", () => {
  it("updates a root-level item", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "Old", actionRef: "r1", enabled: true },
    ];
    const result = updateMenuItem(items, "a", (item) =>
      item.kind === "action" ? { ...item, label: "New" } : item,
    );
    expect(result[0].kind === "action" && result[0].label).toBe("New");
  });

  it("updates a nested item", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "a", label: "Old", actionRef: "r1", enabled: true },
        ],
      },
    ];
    const result = updateMenuItem(items, "a", (item) =>
      item.kind === "action" ? { ...item, label: "Updated" } : item,
    );
    if (result[0].kind === "submenu") {
      expect(result[0].items[0].kind === "action" && result[0].items[0].label).toBe("Updated");
    }
  });

  it("returns unchanged items when targetId is not found", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = updateMenuItem(items, "nonexistent", (item) => item);
    expect(result[0].id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// removeMenuItem
// ---------------------------------------------------------------------------

describe("removeMenuItem", () => {
  it("removes a root-level item", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
      { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
    ];
    const result = removeMenuItem(items, "a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("removes a nested item", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
          { kind: "action", id: "b", label: "B", actionRef: "r2", enabled: true },
        ],
      },
    ];
    const result = removeMenuItem(items, "a");
    if (result[0].kind === "submenu") {
      expect(result[0].items).toHaveLength(1);
      expect(result[0].items[0].id).toBe("b");
    }
  });

  it("cascades removal of empty submenu after removing last child", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "Sub",
        enabled: true,
        items: [
          { kind: "action", id: "only", label: "Only", actionRef: "r1", enabled: true },
        ],
      },
    ];
    const result = removeMenuItem(items, "only");
    expect(result).toHaveLength(0);
  });

  it("cascades nested empty submenu removal", () => {
    const items: MenuItem[] = [
      {
        kind: "submenu",
        id: "s1",
        label: "S1",
        enabled: true,
        items: [
          {
            kind: "submenu",
            id: "s2",
            label: "S2",
            enabled: true,
            items: [
              { kind: "action", id: "deep", label: "Deep", actionRef: "r1", enabled: true },
            ],
          },
        ],
      },
    ];
    const result = removeMenuItem(items, "deep");
    // s2 becomes empty -> removed, s1 becomes empty -> removed
    expect(result).toHaveLength(0);
  });

  it("returns unchanged items when targetId not found", () => {
    const items: MenuItem[] = [
      { kind: "action", id: "a", label: "A", actionRef: "r1", enabled: true },
    ];
    const result = removeMenuItem(items, "nonexistent");
    expect(result).toHaveLength(1);
  });
});
