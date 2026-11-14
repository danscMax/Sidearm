// Writes tools/ui-check/config.js (gitignored) = window.__UI_CONFIG__ for mock.js.
//   node tools/ui-check/make-config.mjs               the seed config (cargo runs the
//                                                     ignored test config::tests::write_seed_config_for_ui_check)
//   node tools/ui-check/make-config.mjs <config.json> a copy of that config (never commit it)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "config.js");

function seedConfig() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sidearm-ui-check-")), "seed.json");
  const installed = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  const cargo = process.env.CARGO ?? (fs.existsSync(installed) ? installed : "cargo");
  const run = spawnSync(cargo, ["test", "--lib", "config::tests::write_seed_config_for_ui_check", "--", "--ignored", "--exact"], {
    cwd: path.join(here, "..", "..", "src-tauri"),
    env: { ...process.env, SIDEARM_SEED_CONFIG_OUT: file },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.status !== 0 || !fs.existsSync(file)) throw new Error(`cargo did not write the seed config (exit ${run.status ?? run.error})`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  // The seed starts with the setup wizard; the check is of the main window.
  config.settings.onboardingCompleted = true;
  return config;
}

const source = process.argv[2];
const config = source ? JSON.parse(fs.readFileSync(source, "utf8")) : seedConfig();
fs.writeFileSync(out, `window.__UI_CONFIG__ = ${JSON.stringify(config)};\n`);
console.log(`${out} <- ${source ?? "seed config"} (${config.profiles?.length ?? 0} profiles)`);
