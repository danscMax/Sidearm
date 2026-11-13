import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { World, dispatched, layoutPlan } from "./run.mjs";

const expected = { controlId: "v3_thumb_03", layer: "standard", encodedKey: "F15", actionId: "action-l", profileId: "default" };
const completed = (patch = {}) => `[capture] E2E execution ${JSON.stringify({ ...expected, outcome: "simulated", ...patch })}\n`;

test("dispatch requires one completed execution with the expected action, profile, control, layer and key", () => {
  for (const field of Object.keys(expected)) {
    assert.equal(dispatched(completed({ [field]: "wrong" }), expected), false, field);
  }
  assert.equal(dispatched(completed({ outcome: "Failed" }), expected), false);
  assert.equal(dispatched(completed(), expected), true);
  assert.equal(dispatched("[capture] E2E execution {truncated\n" + completed(), expected), true);
  assert.equal(dispatched(completed({ actionId: "wrong" }) + completed({ profileId: "wrong" }), expected), false);
  assert.equal(dispatched(completed({ outcome: "menuOpened" }), { ...expected, outcome: "menuOpened" }), true);
});

test("an unrelated simulated completion cannot satisfy a dispatch", () => {
  const log = "Dispatching action for F15 (control v3_thumb_03, layer standard)\n"
    + "Dispatching action for F16 (control v3_thumb_04, layer standard)\n"
    + "Action complete for F16 (outcome: Simulated)\n";
  assert.equal(dispatched(log, expected), false);
});

test("layout rejects empty runs including V2-only, disabled, switch and missing actions", () => {
  const source = { profiles: [{ id: "default" }], actions: [], bindings: [] };
  assert.throws(() => layoutPlan(source), /No testable V3/);
  for (const type of ["shortcut", "disabled", "profileSwitch"]) {
    source.actions = [{ id: "a", type }];
    source.bindings = [{ profileId: "default", controlId: "thumb_01", layer: "standard", enabled: true, actionId: "a" }];
    assert.throws(() => layoutPlan(source), /No testable V3/);
    source.bindings[0].controlId = "v3_thumb_01";
    if (type === "shortcut") assert.equal(layoutPlan(source)[0].bindings.length, 1);
    else assert.throws(() => layoutPlan(source), /No testable V3/);
  }
  source.actions = [];
  assert.throws(() => layoutPlan(source), /No testable V3/);
});

test("concurrent fake mouse edits preserve each other's state under the OS lock", { skip: process.platform !== "win32" }, async () => {
  const world = new World();
  try {
    world.plug("test-mouse", { records: [], pollCode: 1, asleep: false });
    await Promise.all([
      world.edit("test-mouse", async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        state.pollCode = 7;
      }),
      world.edit("test-mouse", (state) => { state.asleep = true; }),
    ]);
    assert.deepEqual(world.mouse("test-mouse"), { records: [], pollCode: 7, asleep: true });
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});
