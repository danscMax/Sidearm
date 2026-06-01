import * as fc from "fast-check";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock @tauri-apps/plugin-log (useLogPanel attaches a logger on mount).
vi.mock("@tauri-apps/plugin-log", () => ({
  attachLogger: vi.fn(() => Promise.resolve(() => {})),
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// useLogPanel ring buffer (PBT) — migrated from the former edge-cases.test.ts
// ---------------------------------------------------------------------------

describe("useLogPanel ring buffer (PBT)", () => {
  // We dynamically import to use the lazy mock setup
  it("after N ingestions (N > 1000), log count is always <= 1000", async () => {
    const { useLogPanel } = await import("./useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 3000 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          expect(result.current.logs.length).toBeLessThanOrEqual(1000);
        },
      ),
      { numRuns: 50 }, // Lower runs: each iteration renders a hook with 1000+ ingestions
    );
  });

  it("first log after overflow has the correct sequential ID", async () => {
    const { useLogPanel } = await import("./useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 2000 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          const logs = result.current.logs;
          // The ring buffer slices from (length - 1000), so the first
          // retained log should have an ID equal to (totalIngestions - 1000 + 1)
          // because IDs start at 1 and increment sequentially.
          // However, the hook uses a ref that persists within the same
          // renderHook instance, so the first log's ID = totalIngestions - 999.
          expect(logs.length).toBe(1000);
          expect(logs[0].id).toBe(totalIngestions - 999);
          expect(logs[logs.length - 1].id).toBe(totalIngestions);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("log IDs are strictly monotonically increasing after overflow", async () => {
    const { useLogPanel } = await import("./useLogPanel");

    fc.assert(
      fc.property(
        fc.integer({ min: 1001, max: 2500 }),
        (totalIngestions) => {
          const { result } = renderHook(() => useLogPanel());

          act(() => {
            for (let i = 0; i < totalIngestions; i++) {
              result.current._ingestForTest({ level: 3, message: `msg-${i}` });
            }
          });

          const logs = result.current.logs;
          for (let i = 1; i < logs.length; i++) {
            expect(logs[i].id).toBeGreaterThan(logs[i - 1].id);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("exact buffer size (1000) does not trigger truncation", async () => {
    const { useLogPanel } = await import("./useLogPanel");

    const { result } = renderHook(() => useLogPanel());

    act(() => {
      for (let i = 0; i < 1000; i++) {
        result.current._ingestForTest({ level: 3, message: `msg-${i}` });
      }
    });

    expect(result.current.logs.length).toBe(1000);
    expect(result.current.logs[0].id).toBe(1);
    expect(result.current.logs[999].id).toBe(1000);
  });
});
