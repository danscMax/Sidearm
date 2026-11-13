import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runtimeCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const macros = new Set((metadata.packages ?? []).filter((pkg) => pkg.targets.some((t) => t.kind.includes("proc-macro"))).map((pkg) => pkg.id));
  const seen = new Set();
  function visit(id) {
    if (seen.has(id) || macros.has(id)) return;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some(({ kind }) => kind === null)) visit(dep.pkg);
    }
  }
  visit(metadata.resolve.root);
  seen.delete(metadata.resolve.root);
  return seen;
}

export function licenseText(dir) {
  const texts = [];
  let hasLicense = false;
  function read(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isFile() && /^(licen[cs]e|unlicense|copying|copyright|notice|authors)([._-]|$)/i.test(entry.name)) {
        const text = fs.readFileSync(file, "utf8").trim();
        if (text) {
          texts.push(`${path.relative(dir, file)}\n${text}`);
          if (/^(licen[cs]e|unlicense|copying)([._-]|$)/i.test(entry.name)) hasLicense = true;
        }
      } else if (entry.isDirectory() && /^licen[cs]es?$/i.test(entry.name)) {
        read(file);
      }
    }
  }
  read(dir);
  if (!hasLicense) throw new Error(`No license text in ${dir}`);
  return texts.join("\n\n");
}

function notices(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const supplements = JSON.parse(fs.readFileSync(path.join(root, "tools/license-supplements.json"), "utf8"));
  const license = (dir, id) => {
    const extra = Object.entries(supplements).filter(([, value]) => value.packages.includes(id));
    if (extra.length) return extra.map(([url, value]) => `${url}\n${value.text.trim()}`).join("\n\n");
    return licenseText(dir);
  };
  const sections = [`Sidearm\n${fs.readFileSync(path.join(root, "LICENSE"), "utf8").trim()}`];
  for (const [location, pkg] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!location || pkg.dev || pkg.devOptional) continue;
    const dir = path.join(root, location);
    const installed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (installed.version !== pkg.version) throw new Error(`Installed version differs from lock: ${location}`);
    sections.push(`npm: ${installed.name}@${pkg.version} (${pkg.license ?? installed.license})\n${license(dir, `npm:${installed.name}@${pkg.version}`)}`);
  }
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", path.join(root, "src-tauri/Cargo.toml"),
    "--locked", "--offline", "--filter-platform", "x86_64-pc-windows-msvc", "--format-version", "1"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
  const runtime = runtimeCrates(metadata);
  for (const pkg of metadata.packages.filter((pkg) => runtime.has(pkg.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    sections.push(`Rust: ${pkg.name}@${pkg.version} (${pkg.license ?? "see license text"})\nUnmodified source: https://crates.io/crates/${pkg.name}/${pkg.version}\nRepository: ${pkg.repository ?? pkg.source}\n${license(path.dirname(pkg.manifest_path), `Rust:${pkg.name}@${pkg.version}`)}`);
  }
  return `Sidearm — third-party licenses and notices\nWindows runtime dependencies from the locked npm/Cargo graphs.\n\n${sections.join("\n\n====================\n\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node tools/licenses.mjs <output-file>");
  fs.writeFileSync(output, notices(root));
  console.log(`Runtime license notices written: ${output}`);
}
