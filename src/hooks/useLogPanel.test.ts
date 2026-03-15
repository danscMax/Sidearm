import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
          "[19:13:52][INFO][naga_workflow_studio_lib::capture_backend] [capture] Capture helper spawned (pid 55528).",
      });
    });

    expect(result.current.logs[0].category).toBe("capture");
    expect(result.current.logs[0].message).toBe(
      "Capture helper spawned (pid 55528).",
    );
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
});
