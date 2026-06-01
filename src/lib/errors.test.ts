import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import type { CommandError } from "./config";
import { translateCommandError, formatErrorForClipboard } from "./errors";

// Fake translator: echoes the key back so assertions can check which key was used.
const t = ((key: string) => key) as unknown as TFunction;

function err(code: string, message = "boom", details?: string[]): CommandError {
  return { code, message, details };
}

describe("translateCommandError", () => {
  it("maps a known code to its title/hint/actions and preserves code + details", () => {
    const details = ["/profiles/0/name: required"];
    const result = translateCommandError(err("schema_violation", "bad", details), t);
    expect(result.code).toBe("schema_violation");
    expect(result.title).toBe("errors.schema.title");
    expect(result.hint).toBe("errors.schema.hint");
    expect(result.message).toBe("bad");
    expect(result.details).toBe(details);
    expect(result.actions.map((a) => a.kind)).toEqual([
      "copyDetails",
      "openLastBackup",
      "openConfigFolder",
    ]);
  });

  it("maps every known code to the expected action set", () => {
    const expected: Record<string, string[]> = {
      schema_violation: ["copyDetails", "openLastBackup", "openConfigFolder"],
      io_error: ["retry", "openConfigFolder", "copyDetails"],
      parse_error: ["openLastBackup", "copyDetails"],
      config_directory_unavailable: ["openConfigFolder", "copyDetails"],
      portable_readonly_fallback: ["openConfigFolder", "dismiss"],
      invalid_config: ["openLastBackup", "copyDetails"],
      invalid_backup_path: ["openConfigFolder", "dismiss"],
      invalid_path: ["dismiss", "copyDetails"],
      runtime_reload_failed: ["retry", "copyDetails"],
    };
    for (const [code, kinds] of Object.entries(expected)) {
      const result = translateCommandError(err(code), t);
      expect(result.actions.map((a) => a.kind), code).toEqual(kinds);
    }
  });

  it("falls back to the default entry for an unknown code", () => {
    const result = translateCommandError(err("totally_unknown_code"), t);
    expect(result.title).toBe("errors.unknown.title");
    expect(result.hint).toBe("errors.unknown.hint");
    expect(result.actions.map((a) => a.kind)).toEqual(["copyDetails", "retry", "dismiss"]);
  });

  it("uses the title as the message when the error message is empty", () => {
    const result = translateCommandError(err("io_error", ""), t);
    expect(result.message).toBe(result.title);
    expect(result.title).toBe("errors.io.title");
  });

  it("leaves details undefined when the error carries none", () => {
    expect(translateCommandError(err("io_error"), t).details).toBeUndefined();
  });
});

describe("formatErrorForClipboard", () => {
  it("joins the [code] message header with each detail line", () => {
    const text = formatErrorForClipboard(err("io_error", "disk full", ["path: C:/x", "errno: 28"]));
    expect(text).toBe("[io_error] disk full\npath: C:/x\nerrno: 28");
  });

  it("returns just the header when there are no details", () => {
    expect(formatErrorForClipboard(err("io_error", "disk full"))).toBe("[io_error] disk full");
  });
});
