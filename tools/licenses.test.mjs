import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { licenseText, runtimeCrates } from "./licenses.mjs";

test("runtime crate traversal excludes build/dev-only dependencies but keeps shared runtime dependencies", () => {
  const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = {
    resolve: { root: "app", nodes: [
      { id: "app", deps: [dep("runtime"), dep("builder", "build"), dep("tests", "dev"), dep("macro")] },
      { id: "runtime", deps: [dep("shared"), dep("builder", "build")] },
      { id: "shared", deps: [] }, { id: "builder", deps: [] }, { id: "tests", deps: [] },
      { id: "macro", deps: [dep("builder")] },
    ] },
    packages: [{ id: "macro", targets: [{ kind: ["proc-macro"] }] }],
  };
  assert.deepEqual([...runtimeCrates(metadata)].sort(), ["runtime", "shared"]);
});

test("notices retain copyright/permission text and refuse a missing license", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidearm-license-test-"));
  try {
    fs.writeFileSync(path.join(dir, "LICENSE-MIT"), "Copyright Example\nPermission is hereby granted");
    fs.mkdirSync(path.join(dir, "licenses"));
    fs.writeFileSync(path.join(dir, "licenses", "NOTICE"), "Bundled authors");
    fs.writeFileSync(path.join(dir, "COPYRIGHT"), "Additional copyright notice");
    const text = licenseText(dir);
    assert.match(text, /Copyright Example\nPermission is hereby granted/);
    assert.match(text, /Bundled authors/);
    assert.match(text, /Additional copyright notice/);
    fs.rmSync(path.join(dir, "LICENSE-MIT"));
    fs.rmSync(path.join(dir, "licenses"), { recursive: true });
    assert.throws(() => licenseText(dir), /No license text/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
