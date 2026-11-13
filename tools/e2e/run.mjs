// End-to-end scenarios against the real app with virtual mice (the `fake-mice`
// build): no USB, nothing sent to the desktop. `npm run e2e` (Windows).
// `npm run e2e -- --layout <config.json>` instead presses every V3 side-button
// assignment of a copy of a real config (see `layoutMain`).
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

// Live-map signals: `live_overlay::USAGES[2 * control index + layer]`; the thumbs come first.
// The V3's consumer usage per key button and layer (src-tauri/src/live_overlay.rs `USAGES`).
const V3_USAGES = [
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
];
const v3Usage = (thumb, layer) => V3_USAGES[2 * (thumb - 1) + layer];
const v2Usage = v3Usage;
// Mouse-hook button codes (`HYPER_TRIGGER_*` in capture_backend/windows.rs).
const RIGHT = 2;

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

  /** One consumer report: the usages held now. The V2 reports one key button
   *  at a time (measured: a second press releases the first). */
  report(device, ...usages) {
    if (device === V2 && usages.length > 1) throw new Error("the V2 reports one button at a time");
    const report = Buffer.alloc(8);
    report[0] = 0x02;
    usages.forEach((usage, index) => report.writeUInt16LE(usage, 1 + 2 * index));
    this.pipes[device].socket?.write(report);
  }

  /** A native mouse button as the mouse hook would see it (fake-mice report 0x7F). */
  nativeButton(device, button, down) {
    this.pipes[device].socket?.write(Buffer.from([0x7f, button, down ? 1 : 0, 0, 0, 0, 0, 0]));
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
  for (const profile of config.profiles) profile.hypershift2Triggers = ["v3_mouse_right"];
  // A profile without HyperShift 2, reached by thumb 6 (ProfileSwitch).
  config.profiles.push({ id: "e2e-plain", name: "E2E plain", enabled: true, priority: 99 });
  for (const profile of config.profiles.filter((p) => p.id !== "e2e-plain")) {
    const actionId = `e2e-${profile.id}-switch`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    config.bindings = config.bindings.filter((b) => !(b.profileId === profile.id && b.controlId === "v3_thumb_06"));
    config.actions.push({ id: actionId, type: "profileSwitch", displayName: "E2E switch", payload: { targetProfileId: "e2e-plain" } });
    config.bindings.push({ id: `${actionId}-binding`, profileId: profile.id, layer: "standard", controlId: "v3_thumb_06", label: "E2E switch", actionId, enabled: true });
  }
  // A menu on HyperShift 2 + thumb 11: item 1 = S, item 2 = T.
  for (const profile of config.profiles.filter((p) => p.id !== "e2e-plain")) {
    const base = `e2e-${profile.id}-menu`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    for (const key of ["S", "T"]) {
      config.actions.push({ id: `${base}-${key.toLowerCase()}`, type: "shortcut", displayName: `E2E ${key}`, payload: { key, ctrl: false, shift: false, alt: false, win: false } });
    }
    config.actions.push({ id: base, type: "menu", displayName: "E2E menu", payload: { items: [
      { kind: "action", id: `${base}-item-s`, label: "S", actionId: `${base}-s`, enabled: true },
      { kind: "action", id: `${base}-item-t`, label: "T", actionId: `${base}-t`, enabled: true },
    ] } });
    config.bindings = config.bindings.filter((b) => !(b.profileId === profile.id && b.controlId === "v3_thumb_11" && b.layer === "hypershift2"));
    config.bindings.push({ id: `${base}-binding`, profileId: profile.id, layer: "hypershift2", controlId: "v3_thumb_11", label: "E2E menu", actionId: base, enabled: true });
  }
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
    // Bound only on the HyperShift 2 layer: still needs its live-map signal.
    ["v3_wheel_click", "hypershift2", undefined, "M"],
    ["v3_thumb_04", "standard", undefined, "P"],
    ["v3_thumb_04", "hypershift2", undefined, "N"],
    ["v3_thumb_04", "hypershiftBoth", undefined, "O"],
    // The V2: a hold-to-release check.
    ["thumb_01", "standard", undefined, "Q"],
    ["thumb_02", "standard", undefined, "R"],
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
    const wheelClick = liveRecords(world.mouse(V3)).find(([, button, layer]) => button === 0x03 && layer === 0);
    check("a HyperShift 2-only button gets a signal", wheelClick?.[3]?.[0] === 0x0a, JSON.stringify(wheelClick));
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

    // 5b. The V2 reports one button at a time: a second press releases the first.
    mark = world.log().length;
    world.report(V2, v2Usage(1, 0));
    await sleep(150);
    world.report(V2, v2Usage(2, 0));
    await sleep(150);
    world.report(V2);
    const v2Order = await world.waitFor(() => world.log(), (t) => {
      const lines = t.split(/\r?\n/);
      const firstUp = lines.findIndex((line) => line.includes("Key-up received"));
      const secondDown = lines.findIndex((line, i) => i > 0 && line.includes("Key-down received") && lines.slice(0, i).some((l) => l.includes("Key-down received")));
      return firstUp >= 0 && secondDown > firstUp;
    }, 5000, mark);
    check("V2: a second button releases the first", v2Order);

    // 5c. HyperShift 2 on the V3's right button (the mouse hook's path, fed by the pipe).
    check("HyperShift 2 trigger sent for the profile", /HyperShift 2 trigger for this profile: 2/.test(world.log()));
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(100);
    await world.press(V3, v3Usage(4, 0));
    world.nativeButton(V3, RIGHT, false);
    check("right held + thumb → HyperShift 2 action", await world.waitFor(() => world.log(), (t) => dispatched(t, "v3_thumb_04", "hypershift2"), 5000, mark));
    await sleep(500);
    check("…and the used trigger does not click", !/HyperShift 2 click/.test(world.log().slice(mark)));
    // Thumb 3 has standard and HyperShift actions but none on HyperShift 2:
    // that layer stands alone, so the press does nothing.
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(100);
    await world.press(V3, v3Usage(3, 0));
    world.nativeButton(V3, RIGHT, false);
    check("an empty HyperShift 2 button does nothing", await world.waitFor(() => world.log(), /Key-down received for \S+ \(hypershift: false, hypershift2: true/, 5000, mark)
      && (await sleep(500), !/Dispatching action for [^\n]*control v3_thumb_03/.test(world.log().slice(mark))));
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(80);
    world.nativeButton(V3, RIGHT, false);
    check("a quick right press clicks", await world.waitFor(() => world.log(), /HyperShift 2 click \(simulated, button 2\)/, 5000, mark));
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(100);
    await world.press(V3, v3Usage(4, 1)); // the ring button's firmware layer
    world.nativeButton(V3, RIGHT, false);
    check("right + ring + thumb → HS + HS2 action", await world.waitFor(() => world.log(), (t) => dispatched(t, "v3_thumb_04", "hypershiftBoth"), 5000, mark));
    // 5d. The menu popup: HyperShift 2 + thumb 11 opens it, thumb 2 picks item 2,
    // and the press drives the menu instead of thumb 2's own action.
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(100);
    await world.press(V3, v3Usage(11, 0));
    world.nativeButton(V3, RIGHT, false);
    check("HyperShift 2 + thumb 11 opens the menu", await world.waitFor(() => world.log(), /\[menu\] opened `E2E menu` \(2 items\)/, 5000, mark));
    await sleep(300);
    mark = world.log().length;
    await world.press(V3, v3Usage(2, 0), 50);
    check("thumb 2 picks item 2", await world.waitFor(() => world.log(), /\[menu\] picked `e2e-[a-z0-9-]+-menu-t`/, 5000, mark));
    check("…which runs on the menu's press", await world.waitFor(() => world.log(), (t) => dispatched(t, "v3_thumb_11", "hypershift2"), 5000, mark));
    await sleep(500);
    check("…and thumb 2's own action does not run", !/control v3_thumb_02/.test(world.log().slice(mark)));
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    await sleep(100);
    await world.press(V3, v3Usage(11, 0));
    world.nativeButton(V3, RIGHT, false);
    await world.waitFor(() => world.log(), /\[menu\] opened/, 5000, mark);
    mark = world.log().length;
    await world.press(V3, v3Usage(11, 0));
    check("the opening button closes the menu", await world.waitFor(() => world.log(), /\[menu\] closed/, 5000, mark));

    mark = world.log().length;
    await world.press(V3, v3Usage(6, 0));
    check("a profile without HyperShift 2 turns it off", await world.waitFor(() => world.log(), /HyperShift 2 trigger for this profile: 0/, 5000, mark));
    mark = world.log().length;
    world.nativeButton(V3, RIGHT, true);
    world.nativeButton(V3, RIGHT, false);
    check("…and the right button passes through", await world.waitFor(() => world.log(), /native button 2 down passed through/, 5000, mark));

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

    // 9. Started while the last exit still waits on a sleeping mouse: the new
    // Sidearm waits for it to be gone (one WebView2 data folder), then takes
    // the mice over from the restorer that exit left once the V2 wakes.
    await world.waitFor(() => "", /never/, 3000);
    world.start();
    await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 40000, world.log().length - 1);
    await sleep(1500);
    // As slow to not answer as a real sleeping mouse: the exit takes seconds.
    world.edit(V2, (state) => { state.asleep = true; state.asleepDelayMs = 300; });
    mark = world.log().length;
    fs.writeFileSync(path.join(world.mice, "quit"), "");
    check("exit waits on the sleeping mouse", await world.waitFor(() => world.log(), /V2 HyperSpeed recovery pending until next start/, 30000, mark));
    fs.rmSync(path.join(world.mice, "quit"), { force: true });
    mark = world.log().length;
    world.start();
    check("a Sidearm started during an exit starts capture", await world.waitFor(() => world.log(), /Capture started/, 90000, mark));
    world.edit(V2, (state) => { state.asleep = false; state.asleepDelayMs = 0; });
    check("…and writes its live maps", await world.waitFor(() => world.log(), /Razer Naga V2 HyperSpeed verified \d+ live assignments/, 40000, mark));
    await world.quit();
  } finally {
    world.cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  // A failed run keeps its folder (logs, mice) to look at.
  if (failed) {
    console.log(`\n${passed}/${results.length} passed — FAILED. Logs: ${world.data}\\logs`);
  } else {
    await sleep(2000);
    fs.rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    console.log(`\n${passed}/${results.length} passed.`);
  }
  process.exit(failed ? 1 : 0);
}

/** Press patterns a binding answers on (`config::Gesture`): hold and chord are plain presses. */
const gestureOf = (mode) => (mode === "longPress" || mode === "doublePress" || mode === "triplePress" ? mode : "press");

/** Presses a V3 key button the way a gesture needs. */
async function pressAs(world, usage, gesture) {
  if (gesture === "longPress") return world.press(V3, usage, 450);
  const taps = gesture === "doublePress" ? 2 : gesture === "triplePress" ? 3 : 1;
  for (let tap = 0; tap < taps; tap += 1) await world.press(V3, usage, 50);
}

/**
 * `--layout <config.json>`: a copy of a real config on the virtual mice. Each
 * profile with V3 side-button assignments becomes the fallback (app rules off,
 * so the foreground window does not matter) and every enabled assignment of
 * its V3 thumbs on the standard and HyperShift layers is pressed in its own
 * press pattern: it must dispatch on that control and layer, a menu must open
 * (and is closed by its button again). Profile switches are skipped (they
 * would change the profile under the next presses).
 */
async function layoutMain(file) {
  if (process.platform !== "win32") throw new Error("Windows only");
  const source = JSON.parse(fs.readFileSync(file, "utf8"));
  build();
  const world = new World();
  console.log(`Run folder: ${world.root}\nLayout: ${file}`);
  const actions = new Map(source.actions.map((action) => [action.id, action]));
  try {
    world.plug(V2, v2State());
    world.plug(V3, v3State());
    world.openPipes(V2, V3);
    world.start();
    await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 30000);
    await world.quit();
    for (const profile of source.profiles) {
      const bindings = source.bindings
        .filter((b) => b.enabled && b.profileId === profile.id && /^v3_thumb_\d+$/.test(b.controlId)
          && (b.layer === "standard" || b.layer === "hypershift"))
        .sort((a, b) => a.controlId.localeCompare(b.controlId) || a.layer.localeCompare(b.layer));
      if (bindings.length === 0) continue;
      const config = structuredClone(source);
      config.appMappings = [];
      config.settings.fallbackProfileId = profile.id;
      world.writeConfig(config);
      let mark = world.log().length;
      world.start();
      check(`${profile.name}: live map written`,
        await world.waitFor(() => world.log(), /Razer Naga V3 Pro verified \d+ live assignments/, 30000, mark));
      await sleep(1500);
      for (const binding of bindings) {
        const action = actions.get(binding.actionId);
        const gesture = gestureOf(binding.triggerMode);
        const name = `${profile.name} · ${binding.controlId.replace("v3_", "")} · ${binding.layer} · ${gesture} → ${binding.label}`;
        if (!action || action.type === "profileSwitch" || action.type === "disabled") continue;
        const usage = v3Usage(Number(binding.controlId.slice("v3_thumb_".length)), binding.layer === "standard" ? 0 : 1);
        mark = world.log().length;
        await pressAs(world, usage, gesture);
        if (action.type === "menu") {
          check(name, await world.waitFor(() => world.log(), /\[menu\] opened/, 4000, mark));
          await sleep(400);
          await world.press(V3, usage, 50); // the opening button closes it
          await world.waitFor(() => world.log(), /\[menu\] closed/, 3000, mark);
        } else {
          check(name, await world.waitFor(() => world.log(), (t) => dispatched(t, binding.controlId, binding.layer), 4000, mark));
        }
        // Past the multi-press window, so the next press starts fresh.
        await sleep(400);
      }
      await world.quit();
    }
  } finally {
    world.cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed${failed ? ` — FAILED. Logs: ${world.data}\\logs` : "."}`);
  if (!failed) fs.rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failed ? 1 : 0);
}

const layoutArg = process.argv.indexOf("--layout");
(layoutArg >= 0 ? layoutMain(process.argv[layoutArg + 1]) : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
