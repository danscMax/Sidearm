import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("rust-cache is pinned to the verified v2 commit, not the annotated tag object", () => {
  // Verified with git ls-remote refs/tags/v2^{} and GitHub's Git commit API.
  const commit = "d1527c8f67ef9af357290475d4af4b0fab8f12e0";
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const pins = [...workflow.matchAll(/^\s*-\s+uses:\s+Swatinem\/rust-cache@(\S+)/gm)]
    .map((match) => match[1]);
  assert.deepEqual(pins, [commit]);
});
