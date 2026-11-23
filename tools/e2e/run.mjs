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
// Beside the shared target dir when one is set (a git worktree builds into the main checkout's).
const TARGET = path.join(process.env.CARGO_TARGET_DIR || path.join(APP, "src-tauri", "target"), "e2e");
const EXE = path.join(TARGET, "debug", "sidearm.exe");
const V2 = "razer-naga";
const V3 = "razer-naga-v3";
// A V3 start is done once its live map is written or it plays Sidearm's own bank.
const V3_READY = /Razer Naga V3 Pro (verified \d+ live assignments|plays the Sidearm bank \d)/;

// Live-map signals: `live_overlay::USAGES[2 * control index + layer]`; the thumbs come first.
// The V3's consumer usage per key button and layer (src-tauri/src/live_overlay.rs `USAGES`).
const V3_USAGES = [
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
];
const v3Usage = (thumb, layer) => V3_USAGES[2 * (thumb - 1) + layer];
// Mouse-hook button codes (`HYPER_TRIGGER_*` in capture_backend/windows.rs).
const RIGHT = 2;
/** `--popups`: the real menu, cheat sheet and OSD windows open (on screen; the menu takes the focus). */
const POPUPS = process.argv.includes("--popups");

const results = [];
let failed = false;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function build() {
  // The whole run below normal (cargo, rustc and the apps inherit it on Windows),
  // so a run beside other sessions' work leaves the desktop responsive.
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
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
    // SIDEARM_E2E_OWNER: every app process ends with this run (`end_with_test_runner`).
    this.env = { ...process.env, SIDEARM_DATA_DIR: this.data, SIDEARM_FAKE_MICE: this.mice, SIDEARM_E2E_OWNER: String(process.pid), ...(POPUPS ? { SIDEARM_FAKE_POPUPS: "1" } : {}) };
    this.pipes = {};
    this.app = null;
  }

  plug(device, state) {
    fs.writeFileSync(path.join(this.mice, `${device}.json`), JSON.stringify(state, null, 2));
  }

  mouse(device) {
    return JSON.parse(fs.readFileSync(path.join(this.mice, `${device}.json`), "utf8"));
  }

  async edit(device, change) {
    // FileStream.Lock and Rust File::lock both lock byte 0 via Win32 file locks.
    const script = `
      $ErrorActionPreference = 'Stop'
      $lock = [IO.File]::Open($env:SIDEARM_E2E_LOCK, 'OpenOrCreate', 'ReadWrite', 'ReadWrite')
      try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ($true) {
          try { $lock.Lock(0, 1); break } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 10
          }
        }
        [Console]::Out.WriteLine('locked')
        [Console]::Out.Flush()
        [Console]::In.ReadLine() | Out-Null
      } finally { $lock.Dispose() }
    `;
    const helper = spawn("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...this.env, SIDEARM_E2E_LOCK: path.join(this.mice, `${device}.lock`) }, windowsHide: true,
    });
    let errors = "";
    helper.stderr.on("data", (chunk) => { errors += chunk; });
    const closed = new Promise((resolve) => helper.on("close", resolve));
    try {
      await new Promise((resolve, reject) => {
        helper.on("error", reject);
        helper.on("close", () => reject(new Error(`Mouse lock helper exited: ${errors}`)));
        helper.stdout.once("data", () => resolve());
      });
      const state = this.mouse(device);
      await change(state);
      const file = path.join(this.mice, `${device}.json`);
      fs.writeFileSync(`${file}.node.tmp`, JSON.stringify(state, null, 2));
      fs.renameSync(`${file}.node.tmp`, file);
    } finally {
      helper.stdin.end();
      await closed;
    }
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

  /** Polls `read()` (from offset `from`) until `pattern` matches. A miss prints
   *  what it waited for and the last 600 characters it read. */
  async waitFor(read, pattern, timeoutMs = 20000, from = 0) {
    const deadline = Date.now() + timeoutMs;
    let text = "";
    while (Date.now() < deadline) {
      text = read().slice(from);
      const found = typeof pattern === "function" ? pattern(text) : pattern.test(text);
      if (found) return true;
      await sleep(200);
    }
    const what = typeof pattern === "function" ? pattern.name || "a condition" : pattern;
    console.log(`      waited ${timeoutMs} ms for ${what}; last read:\n${text.slice(-600).replace(/^/gm, "      | ")}`);
    return false;
  }

  /** Waits for this start's live maps in both mice and its watchdog
   *  (`from`: the app log's length before the start). */
  async startedFully(from) {
    return await this.waitFor(() => this.log(), V3_READY, 40000, from)
      && await this.waitFor(() => this.log(), /Razer Naga V2 HyperSpeed verified \d+ live assignments/, 40000, from)
      && await this.waitFor(() => this.log(), /\[system\] mouse watchdog (running|runs inside)/, 10000, from);
  }

  start() {
    // Hidden: a debug build opens a console window, which would take the focus.
    this.app = spawn(EXE, [], { env: this.env, stdio: "ignore", windowsHide: true });
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

/** Removes a passed run's folder. WebView2 helpers of the last app can hold
 *  `EBWebView` a while longer: a folder left behind does not fail the run. */
function removeRunFolder(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.log(`Run folder not removed (${error.code}): ${root}`);
  }
}

/** Whether every restore process that logged its start in this part of
 *  `restore.log` has logged its end (`[restore] process <pid> done`). */
function restorersDone(text) {
  const started = [...text.matchAll(/\[restore\] process (\d+) started/g)].map((match) => match[1]);
  return started.every((pid) => text.includes(`[restore] process ${pid} done`));
}

const v2State = () => ({ records: [], dpi: {}, pollCode: 1, battery: 200, banks: [], activeBank: 0, slots: {} });
const v3State = () => ({ records: [], dpi: {}, pollCode: 1, battery: 255, banks: [1, 2, 3], activeBank: 1, slots: {} });

const liveRecords = (state) => state.records.filter(([bank]) => bank === 0);
const bankRecords = (state, bank) => state.records.filter(([b]) => b === bank);

/** Assignments the scenarios press: a press and a hold on thumb 1, a press and a
 *  double press on thumb 2, a standard and a HyperShift press on thumb 3. */
function addBindings(config) {
  config.appMappings = [];
  // Keep fixture actions in every profile; no app rules can override the fallback.
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
  // With real popups: the HyperShift 2 cheat sheet, and an OSD bubble per action.
  if (POPUPS) Object.assign(config.settings, { hs2CheatSheet: true, osdEnabled: true, osdActions: true });
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

const dispatched = (text, expected) => text.split(/\r?\n/).some((line) => {
  const marker = "[capture] E2E execution ";
  const offset = line.indexOf(marker);
  if (offset < 0) return false;
  try {
    const execution = JSON.parse(line.slice(offset + marker.length));
    return execution.outcome === (expected.outcome ?? "simulated")
      && Object.entries(expected).every(([key, value]) => execution[key] === value);
  } catch {
    return false;
  }
});

function layoutPlan(source) {
  const actions = new Map(source.actions.map((action) => [action.id, action]));
  const plan = source.profiles.map((profile) => ({
    profile,
    bindings: source.bindings.filter((b) => b.enabled && b.profileId === profile.id
      && /^v3_thumb_\d+$/.test(b.controlId) && ["standard", "hypershift"].includes(b.layer)
      && actions.has(b.actionId) && !["profileSwitch", "disabled"].includes(actions.get(b.actionId).type)),
  })).filter(({ bindings }) => bindings.length > 0);
  if (plan.length === 0) throw new Error("No testable V3 thumb assignments on standard/HyperShift layers (missing, disabled and profile-switch actions are skipped).");
  return plan;
}

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
    await world.waitFor(() => world.log(), V3_READY, 30000);
    check("first start quits on request", await world.quit());
    const config = addBindings(world.config());
    world.writeConfig(config);
    const profileId = config.settings.fallbackProfileId;
    const expectedAction = (controlId, layer, key) => {
      const prefix = `e2e-${profileId}-`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const action = config.actions.find((a) => a.id.startsWith(prefix) && a.displayName === `E2E ${key}`);
      // Consumer signals use the standard key; HS/H2 stamps carry the layer.
      const mapping = config.encoderMappings.find((m) => m.controlId === controlId && m.layer === "standard");
      return { controlId, layer, encodedKey: mapping.encodedKey, actionId: action.id, profileId };
    };

    // 1. Start: live maps in both mice.
    let mark = world.log().length;
    world.start();
    check("V3 plays its Sidearm bank (last free slot 5)", await world.waitFor(() => world.log(), /Razer Naga V3 Pro plays the Sidearm bank 5/, 30000, mark));
    const v3Started = world.mouse(V3);
    check("…a bank of its own, playing", v3Started.banks.includes(5) && v3Started.activeBank === 5, JSON.stringify({ banks: v3Started.banks, active: v3Started.activeBank }));
    check("V2 live map written", await world.waitFor(() => world.log(), /Razer Naga V2 HyperSpeed verified \d+ live assignments/, 30000, mark));
    // Stage 2: the V2's profile 1 keeps the offline profile, stored by its
    // session while Sidearm runs; Sidearm's signals live only in its live map.
    check("V2 offline profile kept in profile 1 at start", /Razer Naga V2 HyperSpeed keeps profile `[^`]+` for use without Sidearm: \d+ records, 0 failed/.test(world.log().slice(mark)));
    // Sidearm's signals: a reserved consumer usage (0x10..0x4e) or a bare F13..F24.
    const sidearmSignal = (record) => (record[0] === 0x0a && record[2] === 0x00 && record[3] >= 0x10 && record[3] <= 0x4e)
      || (record[0] === 0x02 && record[2] === 0x00 && record[3] >= 0x68 && record[3] <= 0x73);
    check("…profile 1 holds no Sidearm signal", !bankRecords(world.mouse(V2), 1).some(([, , , record]) => sidearmSignal(record)),
      JSON.stringify(bankRecords(world.mouse(V2), 1)));
    check("V3 file holds the live map", liveRecords(world.mouse(V3)).length > 0);
    const wheelClick = liveRecords(world.mouse(V3)).find(([, button, layer]) => button === 0x03 && layer === 0);
    check("a HyperShift 2-only button gets a signal", wheelClick?.[3]?.[0] === 0x0a, JSON.stringify(wheelClick));
    await sleep(1500);

    // 2. A plain press dispatches its action (simulated).
    mark = world.log().length;
    await world.press(V3, v3Usage(3, 0));
    check("press → standard action", await world.waitFor(() => world.log(), (t) => dispatched(t, expectedAction("v3_thumb_03", "standard", "L")), 5000, mark));

    // 3. HyperShift (the V3 firmware sends layer 1's signal).
    mark = world.log().length;
    await world.press(V3, v3Usage(3, 1));
    check("HyperShift press → hypershift action", await world.waitFor(() => world.log(), (t) => dispatched(t, expectedAction("v3_thumb_03", "hypershift", "K")), 5000, mark));

    // 5. The profile button takes the V3 to another bank: that is offline mode,
    // nothing is repaired; back on the Sidearm bank it is online again.
    mark = world.log().length;
    await world.edit(V3, (state) => { state.activeBank = 2; });
    check("profile button → offline mode", await world.waitFor(() => world.log(), /plays bank 2 \(profile button\): offline/, 10000, mark));
    await sleep(2500);
    check("…nothing written meanwhile", !/repaired \d+|verified \d+ live assignments|Sidearm bank \d up to date/.test(world.log().slice(mark)), world.log().slice(mark).slice(-600));
    mark = world.log().length;
    await world.edit(V3, (state) => { state.activeBank = 4; });
    check("…and online again on the Sidearm bank", await world.waitFor(() => world.log(), /plays the Sidearm bank 4 again/, 10000, mark));

    if (POPUPS) await popupScenarios(world, expectedAction);

    // 6. Quit: offline profiles in both mice, live maps restored, clean exit.
    mark = world.log().length;
    const v2Flash = JSON.stringify(bankRecords(world.mouse(V2), 1));
    check("quit ends the app", await world.quit());
    const exitLog = world.log().slice(mark);
    // By the exit itself, or already in the background after the start.
    check("V3 banks stored", /Razer Naga V3 Pro (profile `[^`]+` verified in bank \d|banks already stored in the background)/.test(exitLog), exitLog.slice(-800));
    check("the exit leaves the V2's profile 1 alone", JSON.stringify(bankRecords(world.mouse(V2), 1)) === v2Flash && !/V2 HyperSpeed keeps profile/.test(exitLog));
    check("V2 live map back to profile 1's records", liveRecords(world.mouse(V2)).every(([, button, layer, record]) => {
      const flash = bankRecords(world.mouse(V2), 1).find(([, b, l]) => b === button && l === layer)?.[3];
      return flash === undefined || JSON.stringify(flash) === JSON.stringify(record);
    }));
    check("V3 bank 1 holds records", bankRecords(world.mouse(V3), 1).length > 0);
    // Bank 1 plays after exit, its records in the live map (a bank switch reloads it).
    const v3After = world.mouse(V3);
    check("V3 left the Sidearm bank for bank 1, keeping the slot", v3After.activeBank === 1 && v3After.banks.includes(4), JSON.stringify({ banks: v3After.banks, active: v3After.activeBank }));
    const at = (bank, button, layer) => v3After.records.find(([b, n, l]) => b === bank && n === button && l === layer)?.[3];
    // Both ways: every bank-1 record plays, and no live record is left that bank 1 does not hold.
    const wrongLive = [
      ...bankRecords(v3After, 1).filter(([, button, layer, record]) => JSON.stringify(at(0, button, layer)) !== JSON.stringify(record)),
      ...liveRecords(v3After).filter(([, button, layer]) => at(1, button, layer) === undefined),
    ];
    check("V3 live map is bank 1's", wrongLive.length === 0, JSON.stringify(wrongLive));
    check("V3 live rollback file gone", !fs.existsSync(path.join(world.data, `${V3}-live.json`)));
    check("no Sidearm-bank marker left", !fs.existsSync(path.join(world.data, `${V3}-in-sidearm-bank`)));
    check("exit runs off the main thread, step by step", /exit requested \(test run\)/.test(exitLog)
      && /exit step `stop capture`: \d+ ms/.test(exitLog) && /exit work done in \d+ ms/.test(exitLog), exitLog.slice(-1500));
    check("crash sentinel removed", !fs.existsSync(path.join(world.data, "logs", ".running")));

    // 7. Killed: the watchdog restores.
    mark = world.restoreLog().length;
    let appMark = world.log().length;
    world.start();
    check("a start writes both live maps and starts its watchdog", await world.startedFully(appMark));
    await world.kill();
    check("watchdog notices the kill", await world.waitFor(() => world.restoreLog(), /ended without its exit/, 20000, mark));
    check("watchdog takes the V3 off the Sidearm bank", await world.waitFor(() => world.restoreLog(), /Razer Naga V3 Pro left the Sidearm bank 4: bank 1 plays/, 30000, mark));

    // A restorer still holding the mice would make the next start wait for it.
    check("the kill's restore processes end", await world.waitFor(() => world.restoreLog(), restorersDone, 30000, mark));

    // 8. Asleep at exit: queued, written once the mouse wakes. The V3 (a bank
    // select is due); a sleeping V2 needs nothing (its profile 1 holds it).
    appMark = world.log().length;
    world.start();
    await world.startedFully(appMark);
    await world.edit(V3, (state) => { state.asleep = true; });
    mark = world.restoreLog().length;
    await world.quit();
    check("asleep mouse queued", fs.existsSync(path.join(world.data, "mouse-offline-failed")));
    check("…the V3 only", !/\nrazer-naga\b(?!-)/.test(fs.readFileSync(path.join(world.data, "mouse-offline-failed"), "utf8")));
    await world.edit(V3, (state) => { state.asleep = false; });
    check("queued profile written after waking", await world.waitFor(() => (fs.existsSync(path.join(world.data, "mouse-offline-failed")) ? "" : "gone"), /gone/, 30000));
    check("…and its restore process ends", await world.waitFor(() => world.restoreLog(), restorersDone, 30000, mark));

    // 9. Started while the last exit still waits on a sleeping mouse: the new
    // Sidearm waits for it to be gone (one WebView2 data folder), then takes
    // the mice over from the restorer that exit left once the V2 wakes.
    appMark = world.log().length;
    world.start();
    // The V2's live map must be in place: its exit restore is what waits.
    await world.startedFully(appMark);
    // As slow to not answer as a real sleeping mouse: the exit takes seconds.
    await world.edit(V2, (state) => { state.asleep = true; state.asleepDelayMs = 300; });
    mark = world.log().length;
    fs.writeFileSync(path.join(world.mice, "quit"), "");
    check("exit waits on the sleeping mouse", await world.waitFor(() => world.log(), /V2 HyperSpeed recovery pending until next start/, 30000, mark));
    fs.rmSync(path.join(world.mice, "quit"), { force: true });
    mark = world.log().length;
    world.start();
    check("a Sidearm started during an exit starts capture", await world.waitFor(() => world.log(), /Capture started/, 90000, mark));
    await world.edit(V2, (state) => { state.asleep = false; state.asleepDelayMs = 0; });
    check("…and writes its live maps", await world.waitFor(() => world.log(), /Razer Naga V2 HyperSpeed verified \d+ live assignments/, 40000, mark));
    await world.quit();

    // 10. Opt-in Hybrid Hardware Bank (isolated after scenarios 1-9 with an
    // unprepared slot 2): verifies flash records (native Ctrl+C + consumer
    // phrase signal), live bank switch via ProfileSwitch, live records,
    // Sidearm phrase dispatch from the hybrid bank, and watchdog restore to
    // clean bank 1 with zero Sidearm signals in the live map.
    const hybridConfig = world.config();
    const plainProfile = hybridConfig.profiles.find((p) => p.id === "e2e-plain");
    plainProfile.deviceSlots = { [V3]: 2 };
    plainProfile.deviceMouse = { [V3]: { hardwareBank: true } };
    hybridConfig.actions.push(
      { id: "e2e-plain-native", type: "shortcut", displayName: "E2E plain key", payload: { key: "C", ctrl: true, shift: false, alt: false, win: false } },
      { id: "e2e-plain-phrase", type: "textSnippet", displayName: "E2E plain phrase", payload: { source: "inline", text: "hi", pasteMode: "sendText", tags: [] } },
    );
    hybridConfig.bindings.push(
      { id: "e2e-plain-native-binding", profileId: "e2e-plain", layer: "standard", controlId: "v3_thumb_01", label: "Copy", actionId: "e2e-plain-native", enabled: true },
      { id: "e2e-plain-phrase-binding", profileId: "e2e-plain", layer: "standard", controlId: "v3_thumb_02", label: "Phrase", actionId: "e2e-plain-phrase", enabled: true },
    );
    world.writeConfig(hybridConfig);
    // Start with an unprepared bank 2 so cold-start store + verification is exercised.
    await world.edit(V3, (state) => {
      state.records = state.records.filter(([bank]) => bank !== 2);
    });
    appMark = world.log().length;
    mark = world.restoreLog().length;
    world.start();
    check("hybrid start writes live maps and starts watchdog", await world.startedFully(appMark));
    check("hybrid bank 2 verified stored in background", await world.waitFor(() => world.log(), /Razer Naga V3 Pro profile `e2e-plain` verified in bank 2/, 25000, appMark));
    const v3Stored = world.mouse(V3);
    const findRecord = (state, bank, button, layer) => state.records.find(([b, n, l]) => b === bank && n === button && l === layer)?.[3];
    const bank2Native = findRecord(v3Stored, 2, 0x40, 0);
    const bank2Consumer = findRecord(v3Stored, 2, 0x41, 0);
    check("…bank 2 flash holds native Ctrl+C on thumb 1", Boolean(bank2Native && bank2Native[0] === 0x02 && bank2Native[2] === 0x01 && bank2Native[3] === 0x06), JSON.stringify(bank2Native));
    check("…bank 2 flash holds consumer signal on thumb 2", Boolean(bank2Consumer && bank2Consumer[0] === 0x0a && bank2Consumer[2] === 0x00 && bank2Consumer[3] === v3Usage(2, 0)), JSON.stringify(bank2Consumer));
    await sleep(500);
    const switchMark = world.log().length;
    await world.press(V3, v3Usage(6, 0));
    check("ProfileSwitch switches V3 to hybrid bank 2", await world.waitFor(() => world.log(), /Razer Naga V3 Pro profile `E2E plain` switched to live bank 2/, 10000, switchMark));
    const v3Hybrid = world.mouse(V3);
    check("…mouse active bank is now hybrid bank 2", v3Hybrid.activeBank === 2, JSON.stringify({ active: v3Hybrid.activeBank }));
    const liveNative = findRecord(v3Hybrid, 0, 0x40, 0);
    const liveConsumer = findRecord(v3Hybrid, 0, 0x41, 0);
    check("…live map holds native Ctrl+C on thumb 1", Boolean(liveNative && liveNative[0] === 0x02 && liveNative[2] === 0x01 && liveNative[3] === 0x06), JSON.stringify(liveNative));
    check("…live map holds consumer signal on thumb 2", Boolean(liveConsumer && liveConsumer[0] === 0x0a && liveConsumer[2] === 0x00 && liveConsumer[3] === v3Usage(2, 0)), JSON.stringify(liveConsumer));
    const phraseMark = world.log().length;
    await world.press(V3, v3Usage(2, 0));
    check("…Sidearm-only phrase still dispatches from hybrid bank", await world.waitFor(() => world.log(), (t) => dispatched(t, {
      controlId: "v3_thumb_02",
      layer: "standard",
      actionId: "e2e-plain-phrase",
      profileId: "e2e-plain",
    }), 5000, phraseMark));
    await world.kill();
    check("watchdog restores clean offline bank 1 from hybrid bank 2", await world.waitFor(() => world.restoreLog(), /Razer Naga V3 Pro left the hybrid bank 2: bank 1 plays/, 30000, mark));
    const v3Restored = world.mouse(V3);
    check("…mouse active bank is back on clean bank 1", v3Restored.activeBank === 1, JSON.stringify({ active: v3Restored.activeBank }));
    const restoredWrong = [
      ...bankRecords(v3Restored, 1).filter(([, button, layer, record]) => JSON.stringify(findRecord(v3Restored, 0, button, layer)) !== JSON.stringify(record)),
      ...liveRecords(v3Restored).filter(([, button, layer]) => findRecord(v3Restored, 1, button, layer) === undefined),
    ];
    check("…restored live map matches clean bank 1 with zero Sidearm signals", restoredWrong.length === 0 && !liveRecords(v3Restored).some(([, , , rec]) => sidearmSignal(rec)), JSON.stringify({ restoredWrong, live: liveRecords(v3Restored) }));
    check("…and hybrid kill restorer ends", await world.waitFor(() => world.restoreLog(), restorersDone, 30000, mark));
  } finally {
    world.cleanup();
  }
  const passed = results.filter((r) => r.ok).length;
  // A failed run keeps its folder (logs, mice) to look at.
  if (failed) {
    console.log(`\n${passed}/${results.length} passed — FAILED. Logs: ${world.data}\\logs`);
  } else {
    await sleep(2000);
    removeRunFolder(world.root);
    console.log(`\n${passed}/${results.length} passed.`);
  }
  process.exit(failed ? 1 : 0);
}

/** Press patterns a binding answers on (`config::Gesture`): hold and chord are plain presses. */
const gestureOf = (mode) => (mode === "longPress" || mode === "doublePress" || mode === "triplePress" ? mode : "press");

/** Presses a V3 key button the way a gesture needs. */
/** `--popups` only: the real windows show and hide, and releasing the HyperShift 2
 *  trigger right as the cheat sheet appears freezes nothing (the main thread
 *  keeps answering and the next press still runs). */
async function popupScenarios(world, expectedAction) {
  let mark = world.log().length;
  world.nativeButton(V3, RIGHT, true);
  await sleep(100);
  await world.press(V3, v3Usage(11, 0));
  world.nativeButton(V3, RIGHT, false);
  check("popups: the menu window is shown", await world.waitFor(() => world.log(), /\[menu\] shown \(\d+x\d+\)/, 8000, mark));
  mark = world.log().length;
  await world.press(V3, v3Usage(11, 0));
  check("popups: …and closed by its button", await world.waitFor(() => world.log(), /\[menu\] closed/, 5000, mark));
  mark = world.log().length;
  world.nativeButton(V3, RIGHT, true);
  check("popups: the cheat sheet shows after a 1 s hold", await world.waitFor(() => world.log(), /\[cheatsheet\] shown/, 8000, mark));
  world.nativeButton(V3, RIGHT, false);
  check("popups: …and goes on release", await world.waitFor(() => world.log(), /\[cheatsheet\] hidden/, 5000, mark));
  // Let go around the moment the sheet appears, again and again.
  for (let i = 0; i < 8; i += 1) {
    world.nativeButton(V3, RIGHT, true);
    await sleep(940 + i * 15);
    world.nativeButton(V3, RIGHT, false);
    await sleep(150);
  }
  mark = world.log().length;
  await world.press(V3, v3Usage(3, 0));
  check("popups: a press still runs after the release race", await world.waitFor(() => world.log(), (t) => dispatched(t, expectedAction("v3_thumb_03", "standard", "L")), 5000, mark));
  check("popups: the main thread never stopped answering", !/main thread has not answered/.test(world.log()));
  check("popups: an action's OSD bubble shows (or a fullscreen window holds it back)", /\[osd\] (shown|skipped: a fullscreen window is in front)/.test(world.log()));
}

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
  const plan = layoutPlan(source);
  build();
  const world = new World();
  console.log(`Run folder: ${world.root}\nLayout: ${file}`);
  const actions = new Map(source.actions.map((action) => [action.id, action]));
  let tested = 0;
  try {
    world.plug(V2, v2State());
    world.plug(V3, v3State());
    world.openPipes(V2, V3);
    world.start();
    await world.waitFor(() => world.log(), V3_READY, 30000);
    await world.quit();
    for (const { profile, bindings } of plan) {
      bindings.sort((a, b) => a.controlId.localeCompare(b.controlId) || a.layer.localeCompare(b.layer));
      const config = structuredClone(source);
      config.appMappings = [];
      config.settings.fallbackProfileId = profile.id;
      world.writeConfig(config);
      let mark = world.log().length;
      world.start();
      check(`${profile.name}: live map written`,
        await world.waitFor(() => world.log(), V3_READY, 30000, mark));
      await sleep(1500);
      for (const binding of bindings) {
        const action = actions.get(binding.actionId);
        const gesture = gestureOf(binding.triggerMode);
        const name = `${profile.name} · ${binding.controlId.replace("v3_", "")} · ${binding.layer} · ${gesture} → ${binding.label}`;
        const usage = v3Usage(Number(binding.controlId.slice("v3_thumb_".length)), binding.layer === "standard" ? 0 : 1);
        const mapping = config.encoderMappings.find((m) => m.controlId === binding.controlId && m.layer === "standard");
        const expected = {
          controlId: binding.controlId, layer: binding.layer, encodedKey: mapping.encodedKey,
          actionId: binding.actionId, profileId: profile.id,
        };
        mark = world.log().length;
        await pressAs(world, usage, gesture);
        if (action.type === "menu") {
          check(name, await world.waitFor(() => world.log(), (t) => dispatched(t, { ...expected, outcome: "menuOpened" }), 4000, mark));
          await sleep(400);
          await world.press(V3, usage, 50); // the opening button closes it
          check(`${name}: menu closed`, await world.waitFor(() => world.log(), /\[menu\] closed/, 3000, mark));
        } else {
          check(name, await world.waitFor(() => world.log(), (t) => dispatched(t, expected), 4000, mark));
        }
        tested += 1;
        // Past the multi-press window, so the next press starts fresh.
        await sleep(400);
      }
      await world.quit();
    }
  } finally {
    world.cleanup();
  }
  check("layout exercised at least one assignment", tested > 0);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed${failed ? ` — FAILED. Logs: ${world.data}\\logs` : "."}`);
  if (!failed) removeRunFolder(world.root);
  process.exit(failed ? 1 : 0);
}

export { World, dispatched, layoutPlan, restorersDone };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const layoutArg = process.argv.indexOf("--layout");
  (layoutArg >= 0 ? layoutMain(process.argv[layoutArg + 1]) : main()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
