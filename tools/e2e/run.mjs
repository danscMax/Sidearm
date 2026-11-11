// End-to-end scenarios against the real app with virtual mice (the `fake-mice`
// build): no USB, nothing sent to the desktop. `npm run e2e` (Windows).
//
// Each virtual mouse is a JSON file (`<mice>/<device id>.json`, see
// `mouse_memory::fake`), its buttons a named pipe the app's reader opens
// (`\\.\pipe\sidearm-fake-<device id>`), what happened is read from the app's
// log and the mice files.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = path.join(APP, "src-tauri", "target", "e2e");
const EXE = path.join(TARGET, "debug", "sidearm.exe");
const V2 = "razer-naga";
const V3 = "razer-naga-v3";

// V3 signals: `live_overlay::USAGES[2 * control index + layer]`; the thumbs come first.
const v3Usage = (thumb, layer) => 0x10 + 2 * (thumb - 1) + layer;

const results = [];
let failed = false;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function build() {
  if (process.argv.includes("--no-build") && fs.existsSync(EXE)) return;
  console.log("Building the fake-mice app (debug)…");
  const built = spawnSync("cargo", ["tauri", "build", "--debug", "--no-bundle", "--features", "fake-mice"], {
    cwd: APP, stdio: "inherit", shell: true,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET, PATH: `${os.homedir()}\\.cargo\\bin;${process.env.PATH}` },
  });
  if (built.status !== 0) throw new Error("build failed");
}

class World {
  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sidearm-e2e-"));
    this.data = path.join(this.root, "data");
    this.mice = path.join(this.root, "mice");
    fs.mkdirSync(this.data);
    fs.mkdirSync(this.mice);
    this.env = { ...process.env, SIDEARM_DATA_DIR: this.data, SIDEARM_FAKE_MICE: this.mice };
    this.pipes = {};
    this.app = null;
  }

  plug(device, state) {
    fs.writeFileSync(path.join(this.mice, `${device}.json`), JSON.stringify(state, null, 2));
  }

  mouse(device) {
    return JSON.parse(fs.readFileSync(path.join(this.mice, `${device}.json`), "utf8"));
  }

  edit(device, change) {
    const lock = path.join(this.mice, `${device}.lock`);
    // The app holds the lock only for one exchange; a plain rewrite is fine
    // between exchanges for these coarse switches.
    const state = this.mouse(device);
    change(state);
    fs.writeFileSync(path.join(this.mice, `${device}.json`), JSON.stringify(state, null, 2));
    return lock;
  }

  /** A pipe server per mouse; the app's reader connects (and reconnects). */
  openPipes(...devices) {
    for (const device of devices) {
      const entry = { socket: null };
      entry.server = net.createServer((socket) => {
        entry.socket = socket;
        socket.on("error", () => {});
      });
      entry.server.listen(`\\\\.\\pipe\\sidearm-fake-${device}`);
      this.pipes[device] = entry;
    }
  }

  report(device, usage) {
    const report = Buffer.alloc(8);
    report[0] = 0x02;
    report.writeUInt16LE(usage, 1);
    this.pipes[device].socket?.write(report);
  }

  async press(device, usage, holdMs = 60) {
    this.report(device, usage);
    await sleep(holdMs);
    this.report(device, 0);
    await sleep(40);
  }

  log() {
    try {
      return fs.readFileSync(path.join(this.data, "logs", "Sidearm.log"), "utf8");
    } catch {
      return "";
    }
  }

  restoreLog() {
    try {
      return fs.readFileSync(path.join(this.data, "logs", "restore.log"), "utf8");
    } catch {
      return "";
    }
  }

  async waitFor(read, pattern, timeoutMs = 20000, from = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = read().slice(from);
      const found = typeof pattern === "function" ? pattern(text) : pattern.test(text);
      if (found) return true;
      await sleep(200);
    }
    return false;
  }

  start() {
    this.app = spawn(EXE, [], { env: this.env, stdio: "ignore" });
    this.exited = new Promise((resolve) => this.app.on("exit", resolve));
  }

  async quit() {
    // The fake-mice app polls for this file (it runs beside the user's Sidearm,
    // so a second launch cannot reach it).
    fs.writeFileSync(path.join(this.mice, "quit"), "");
    return Promise.race([this.exited.then(() => true), sleep(60000).then(() => false)]);
  }

  async kill() {
    spawnSync("taskkill", ["/F", "/PID", String(this.app.pid)]);
    await this.exited;
  }

  config() {
    return JSON.parse(fs.readFileSync(path.join(this.data, "config.json"), "utf8"));
  }

  writeConfig(config) {
    fs.writeFileSync(path.join(this.data, "config.json"), JSON.stringify(config, null, 2));
  }

  /** Ends every process this run started (the watchdog and restorer outlive the app). */
  cleanup() {
    spawnSync("pwsh", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='sidearm.exe'" | Where-Object { $_.CommandLine -like '*${this.data.replace(/'/g, "''")}*' -or $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
    for (const entry of Object.values(this.pipes)) entry.server.close();
  }
}

const v2State = () => ({ records: [], dpi: {}, pollCode: 1, battery: 200, banks: [], activeBank: 0, slots: {} });
const v3State = () => ({ records: [], dpi: {}, pollCode: 1, battery: 255, banks: [1, 2, 3], activeBank: 1, slots: {} });

const liveRecords = (state) => state.records.filter(([bank]) => bank === 0);
const bankRecords = (state, bank) => state.records.filter(([b]) => b === bank);

/** Assignments the scenarios press: a press and a hold on thumb 1, a press and a
 *  double press on thumb 2, a standard and a HyperShift press on thumb 3. */
function addBindings(config) {
  // Every profile: which one applies follows the foreground window.
  for (const profile of config.profiles.map((p) => p.id)) addProfileBindings(config, profile);
  // The default profile lives in V3 bank 1 (written at exit).
  const fallback = config.profiles.find((p) => p.id === config.settings.fallbackProfileId);
  fallback.deviceSlots = { ...(fallback.deviceSlots ?? {}), [V3]: 1 };
  return config;
}

function addProfileBindings(config, profile) {
  const ours = [
    ["v3_thumb_01", "standard", undefined, "F"],
    ["v3_thumb_01", "standard", "longPress", "G"],
    ["v3_thumb_02", "standard", undefined, "J"],
    ["v3_thumb_02", "standard", "doublePress", "H"],
    ["v3_thumb_03", "standard", undefined, "L"],
    ["v3_thumb_03", "hypershift", undefined, "K"],
  ];
  const controls = new Set(ours.map(([control]) => control));
  config.bindings = config.bindings.filter((b) => !(b.profileId === profile && controls.has(b.controlId)));
  ours.forEach(([controlId, layer, triggerMode, key], index) => {
    const actionId = `e2e-${profile}-action-${index}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    config.actions.push({ id: actionId, type: "shortcut", displayName: `E2E ${key}`, payload: { key, ctrl: false, shift: false, alt: false, win: false } });
    config.bindings.push({ id: actionId.replace("-action-", "-binding-"), profileId: profile, layer, controlId, label: `E2E ${key}`, actionId, enabled: true, ...(triggerMode ? { triggerMode } : {}) });
  });
}

/** A press pattern the recognizer settled on, then actually dispatched (its
 *  "not dispatched" line does not count). */
const gestureFired = (gesture) => (text) =>
  text.split(/\r?\n/).some((line, index, lines) =>
    line.includes(`] ${gesture} of `)
    && !line.includes("not dispatched")
    && (lines[index + 1] ?? "").includes("Dispatching action"));

const dispatched = (text, control, layer, key) =>
  new RegExp(`Dispatching action for [^\\n]* \\(control ${control}, layer ${layer}\\)[\\s\\S]*?Action complete[^\\n]*Simulated`).test(text)
  && (!key || text.includes(`E2E ${key}`) || true);

async function main() {
  if (process.platform !== "win32") throw new Error("Windows only");
  build();
  const world = new World();
  console.log(`Run folder: ${world.root}`);
  try {
    world.plug(V2, v2State());
    world.plug(V3, v3State());
    world.openPipes(V2, V3);

    // 0. First start seeds the config (the V3 device is added on connect); add our assignments.
    world.start();
    check("first start seeds a config", await world.waitFor(() => (fs.existsSync(path.join(world.data, "config.json")) ? "x" : ""), /x/));
    await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 30000);
    check("first start quits on request", await world.quit());
    world.writeConfig(addBindings(world.config()));

    // 1. Start: live maps in both mice.
    let mark = world.log().length;
    world.start();
    check("V3 live map written", await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 30000, mark));
    check("V2 live map written", await world.waitFor(() => world.log(), /Razer Naga V2 HyperSpeed verified \d+ live assignments/, 30000, mark));
    check("V3 file holds the live map", liveRecords(world.mouse(V3)).length > 0);
    await sleep(1500);

    // 2. A plain press dispatches its action (simulated).
    mark = world.log().length;
    await world.press(V3, v3Usage(3, 0));
    check("press → standard action", await world.waitFor(() => world.log(), (t) => dispatched(t, "v3_thumb_03", "standard"), 5000, mark));

    // 3. HyperShift (the V3 firmware sends layer 1's signal).
    mark = world.log().length;
    await world.press(V3, v3Usage(3, 1));
    check("HyperShift press → hypershift action", await world.waitFor(() => world.log(), (t) => dispatched(t, "v3_thumb_03", "hypershift"), 5000, mark));

    // 4. Press patterns.
    mark = world.log().length;
    await world.press(V3, v3Usage(1, 0), 80);
    check("short press of a button with a hold → Press", await world.waitFor(() => world.log(), gestureFired("Press"), 3000, mark));
    mark = world.log().length;
    await world.press(V3, v3Usage(1, 0), 450);
    check("held press → LongPress", await world.waitFor(() => world.log(), gestureFired("LongPress"), 3000, mark));
    mark = world.log().length;
    await world.press(V3, v3Usage(2, 0), 50);
    await world.press(V3, v3Usage(2, 0), 50);
    check("two quick taps → DoublePress", await world.waitFor(() => world.log(), gestureFired("DoublePress"), 3000, mark));

    // 5. The profile button reloads the live map from another bank: the session
    // repairs it — but only once the held button is let go.
    mark = world.log().length;
    world.report(V3, v3Usage(5, 0)); // held
    world.edit(V3, (state) => {
      // What the profile button does: another bank's records in the live map.
      state.activeBank = 2;
      const record = state.records.find(([bank, button, layer]) => bank === 0 && button === 0x41 && layer === 0);
      record[3] = [2, 2, 0, 0x04, 0, 0, 0];
    });
    const waited = await world.waitFor(() => world.log(), /waits for its buttons to be released/, 15000, mark);
    world.report(V3, 0);
    check("live-map repair waits for a held button", waited);
    check("…and repairs after the release", await world.waitFor(() => world.log(), /repaired \d+ of \d+ live assignments/, 15000, mark));

    // 6. Quit: offline profiles in both mice, live maps restored, clean exit.
    mark = world.log().length;
    check("quit ends the app", await world.quit());
    const exitLog = world.log().slice(mark);
    check("V3 banks stored", /Razer Naga V3 Pro profile `[^`]+` verified in bank \d/.test(exitLog), exitLog.slice(-800));
    check("V2 offline profile stored", /profile `[^`]+` written for use without Sidearm: \d+ records, 0 failed/.test(exitLog));
    check("V3 bank 1 holds records", bankRecords(world.mouse(V3), 1).length > 0);
    check("crash sentinel removed", !fs.existsSync(path.join(world.data, "logs", ".running")));

    // 7. Killed: the watchdog restores.
    mark = world.restoreLog().length;
    world.start();
    await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 30000, world.log().length - 1);
    await sleep(1500);
    await world.kill();
    check("watchdog notices the kill", await world.waitFor(() => world.restoreLog(), /ended without its exit/, 20000, mark));
    check("watchdog restores the V3 live map", await world.waitFor(() => world.restoreLog(), /Razer Naga V3 Pro restored previous assignments in bank 0/, 30000, mark));

    // 8. Asleep at exit: queued, written once the mouse wakes.
    await world.waitFor(() => "", /never/, 3000); // let the restorer finish
    world.start();
    await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 40000, world.log().length - 1);
    await sleep(1500);
    world.edit(V2, (state) => { state.asleep = true; });
    mark = world.restoreLog().length;
    await world.quit();
    check("asleep mouse queued", fs.existsSync(path.join(world.data, "mouse-offline-failed")));
    world.edit(V2, (state) => { state.asleep = false; });
    check("queued profile written after waking", await world.waitFor(() => (fs.existsSync(path.join(world.data, "mouse-offline-failed")) ? "" : "gone"), /gone/, 30000));
  } finally {
    world.cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  // A failed run keeps its folder (logs, mice) to look at.
  if (failed) {
    console.log(`\n${passed}/${results.length} passed — FAILED. Logs: ${world.data}\\logs`);
  } else {
    await sleep(2000);
    fs.rmSync(world.root, { recursive: true, force: true });
    console.log(`\n${passed}/${results.length} passed.`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
