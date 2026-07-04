import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { attachLogger } from "@tauri-apps/plugin-log";
import { useLogPanel } from "./useLogPanel";

// Mock @tauri-apps/plugin-log
vi.mock("@tauri-apps/plugin-log", () => ({
  attachLogger: vi.fn(() => Promise.resolve(() => {})),
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}));

describe("useLogPanel", () => {
  it("starts with empty logs", () => {
    const { result } = renderHook(() => useLogPanel());
    expect(result.current.logs).toEqual([]);
    expect(result.current.filteredLogs).toEqual([]);
  });

  it("ingests log entries and extracts category from [bracket] prefix", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 5, message: "[capture] Hook failed" });
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0].category).toBe("capture");
    expect(result.current.logs[0].message).toBe("Hook failed");
    expect(result.current.logs[0].level).toBe("error");
  });

  it("uses 'app' as default category when no bracket prefix", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 3, message: "plain message" });
    });

    expect(result.current.logs[0].category).toBe("app");
    expect(result.current.logs[0].message).toBe("plain message");
  });

  it("strips tauri-plugin-log formatted prefix", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({
        level: 3,
        message:
          "[19:13:52][INFO][sidearm_lib::capture_backend] [capture] Capture helper spawned (pid 55528).",
      });
    });

    expect(result.current.logs[0].category).toBe("capture");
    expect(result.current.logs[0].message).toBe(
      "Capture helper spawned (pid 55528).",
    );
  });

  it("strips the release-build prefix that includes a leading date group", () => {
    // Release builds emit [YYYY-MM-DD][HH:MM:SS][LEVEL][module] — the date
    // group used to break the strip, leaking the raw prefix into the UI and
    // mis-parsing the date as the category.
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({
        level: 3,
        message:
          "[2026-07-04][18:49:08][INFO][sidearm_lib::capture_backend] [capture] Hold-shortcut already held for Alt+F24, skipping duplicate",
      });
    });

    expect(result.current.logs[0].category).toBe("capture");
    expect(result.current.logs[0].message).toBe(
      "Hold-shortcut already held for Alt+F24, skipping duplicate",
    );
  });

  it("keeps a body that starts with its own lowercase bracket tokens intact", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({
        level: 4,
        message: "[warn][retry] connecting",
      });
    });

    // No uppercase LEVEL group in the leading run — nothing is stripped; the
    // first bracket is treated as the category as before.
    expect(result.current.logs[0].category).toBe("warn");
    expect(result.current.logs[0].message).toBe("[retry] connecting");
  });

  it("strips plugin prefix and defaults category when no custom bracket", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({
        level: 4,
        message: "[19:13:52][WARN][hyper::proto] connection reset",
      });
    });

    expect(result.current.logs[0].category).toBe("app");
    expect(result.current.logs[0].message).toBe("connection reset");
  });

  it("maps plugin LogLevel numbers to string names", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 1, message: "t" }); // trace
      result.current._ingestForTest({ level: 2, message: "d" }); // debug
      result.current._ingestForTest({ level: 3, message: "i" }); // info
      result.current._ingestForTest({ level: 4, message: "w" }); // warn
      result.current._ingestForTest({ level: 5, message: "e" }); // error
    });

    expect(result.current.logs.map((l) => l.level)).toEqual([
      "trace", "debug", "info", "warn", "error",
    ]);
  });

  it("filters logs by level", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 5, message: "error msg" });
      result.current._ingestForTest({ level: 3, message: "info msg" });
      result.current._ingestForTest({ level: 4, message: "warn msg" });
    });

    act(() => {
      result.current.setLevelFilter("error");
    });

    expect(result.current.filteredLogs).toHaveLength(1);
    expect(result.current.filteredLogs[0].message).toBe("error msg");
  });

  it("filters logs by category", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 3, message: "[capture] a" });
      result.current._ingestForTest({ level: 3, message: "[runtime] b" });
    });

    act(() => {
      result.current.setCategoryFilter("capture");
    });

    expect(result.current.filteredLogs).toHaveLength(1);
    expect(result.current.filteredLogs[0].message).toBe("a");
  });

  it("filters logs by search query (case-insensitive)", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 3, message: "[a] Foo Bar" });
      result.current._ingestForTest({ level: 3, message: "[a] Baz Qux" });
    });

    act(() => {
      result.current.setSearchQuery("foo");
    });

    expect(result.current.filteredLogs).toHaveLength(1);
    expect(result.current.filteredLogs[0].message).toBe("Foo Bar");
  });

  it("combines multiple filters", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 5, message: "[capture] error in hook" });
      result.current._ingestForTest({ level: 5, message: "[runtime] error in start" });
      result.current._ingestForTest({ level: 3, message: "[capture] info event" });
    });

    act(() => {
      result.current.setLevelFilter("error");
      result.current.setCategoryFilter("capture");
    });

    expect(result.current.filteredLogs).toHaveLength(1);
    expect(result.current.filteredLogs[0].message).toBe("error in hook");
  });

  it("respects ring buffer limit of 1000", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      for (let i = 0; i < 1100; i++) {
        result.current._ingestForTest({ level: 3, message: `msg-${i}` });
      }
    });

    expect(result.current.logs).toHaveLength(1000);
    expect(result.current.logs[0].message).toBe("msg-100");
  });

  it("collects unique categories sorted alphabetically", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 3, message: "[capture] a" });
      result.current._ingestForTest({ level: 3, message: "[runtime] b" });
      result.current._ingestForTest({ level: 3, message: "[capture] c" });
    });

    expect(result.current.categories).toEqual(["capture", "runtime"]);
  });

  it("clearLogs resets everything", () => {
    const { result } = renderHook(() => useLogPanel());

    act(() => {
      result.current._ingestForTest({ level: 3, message: "test" });
    });
    expect(result.current.logs).toHaveLength(1);

    act(() => {
      result.current.clearLogs();
    });

    expect(result.current.logs).toEqual([]);
    expect(result.current.filteredLogs).toEqual([]);
    expect(result.current.categories).toEqual([]);
  });

  // Audit F038: if the effect cleanup runs before attachLogger resolves (the
  // StrictMode double-mount), the resolved detach fn must still be invoked so
  // the first logger does not leak and duplicate log lines.
  it("detaches the logger even when unmount races the attach promise", async () => {
    let resolveAttach: ((detach: () => void) => void) | undefined;
    const detach = vi.fn();
    vi.mocked(attachLogger).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveAttach = resolve;
        }),
    );

    const { unmount } = renderHook(() => useLogPanel());
    // Unmount before the attach promise resolves — detach is still null here.
    unmount();
    // Now the logger finally attaches; cleanup already ran, so it must be torn
    // down immediately.
    await act(async () => {
      resolveAttach?.(detach);
      await Promise.resolve();
    });

    expect(detach).toHaveBeenCalledTimes(1);
  });
});
