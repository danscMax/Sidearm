# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

---

# Project — Sidearm

## Purpose

Windows-first desktop app that remaps a programmable mouse (Razer Naga) and keyboard into per-app keyboard shortcuts, text snippets, macros, launches, and profile switching, with automatic profile switching on the foreground app. Dark theme only.

## Stack

- Frontend: `src/` — React 19 (+ react-compiler), TypeScript, Vite, i18next (EN + RU)
- Backend: `src-tauri/` — Tauri v2, Rust (edition 2024)
- IPC: `#[tauri::command]` handlers invoked from `src/lib/backend.ts`

## Project-Wide Contracts

- Code comments in English.
- All user-facing text goes through i18next with matching `en.json` + `ru.json` keys — never hardcode UI strings. That includes text the Rust backend produces: no Russian (or other non-English) literals in Rust — see `src-tauri/AGENTS.md` (`ui_text!`).
- No AI/assistant attribution anywhere (commits, PRs, code, docs).
- Config is the source of truth: schema-first (`schemas/config.v5.schema.json` at the repo root, runtime-validated), atomic writes, rolling + daily backups, corrupt-recovery. The TS `AppConfig` (`src/lib/config.ts`) and Rust structs must stay in sync with the schema.
- Adding an `ActionType` touches many mirrored sites — see `src/components/action-picker/AGENTS.md`.
- `CONTEXT.md` defines button identity, profile assignment, and the global HyperShift role; keep the role distinct from an executable action.
- Fix root causes, not symptoms. Reuse existing shared primitives/helpers before adding new ones.
- Portable packages include `THIRD-PARTY-NOTICES.txt` (Sidearm plus locked Windows npm/Rust runtime licenses). `tools/licenses.mjs` generates it offline from installed packages/Cargo metadata, excluding build/dev-only and proc-macro crates; version-specific missing upstream texts live in `tools/license-supplements.json`. Missing license text fails assembly; package verification and release ZIP creation require the notice file.

## Verification

Run before declaring a code change done:

- Everything at once: `npm run verify` (= `npm run check` + `test:rust` + `test` + `test:tools` + `e2e`); `release.ps1` runs it once per commit.
- Frontend: `npm run check` (= `tsc --noEmit` + `knip` dead-code + `cargo clippy --all-targets -D warnings`) and `npm run test` (vitest).
- Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml`.
- Release: `pwsh -File release.ps1 -Version X.Y.Z [-Publish]` — checks versions/CHANGELOG/clean tree, runs `npm run verify` (a pass is remembered per commit in `plans\release\verified-<commit>`), builds, Authenticode-signs (an exe already signed with our certificate is kept, so its hash stays the tested one) `portable\Sidearm.exe` on MiniPC (GlobalSign cert on its Rutoken, via SweetWhisper's `scripts\sign-windows.ps1`; the result is checked against `SweetWhisperpp\src-tauri\codesign\sweetwhisper-codesign.cer`), zips (a settings-format change since the last tag heads the release notes in EN + RU), and with `-Publish` — only after `pwsh -File tools\hw-check.ps1 -Version X.Y.Z` recorded every hardware check passed for this very exe's SHA-256 (`plans\release\hw-check-vX.Y.Z.json`) — tags, pushes and creates the GitHub release. A signed exe changes its hash: the elevated autostart pin needs a reconfirm.
- Integration smoke: `pwsh -File build_portable.ps1` (release build + WebView2 packaging; build via pwsh, not cmd; also runs cargo audit and full `npm audit --audit-level=high`, including build/test tooling; accepted Rust advisories live in `.cargo/audit.toml`). High/critical npm findings block the gate, lower severities remain visible. An npm audit that cannot reach the registry (ECONNRESET, "audit endpoint returned an error") is retried 3 times 10 s apart; still unreachable, a local build continues with a warning (npm not audited that run), while `release.ps1` passes `-StrictAudit` and stops.
- Dev runs (`dev.ps1` → `cargo tauri dev`; `dev.ps1 -NoWatch` / `dev.bat -NoWatch` passes `--no-watch`, so a saved file does not rebuild and restart the app — each restart kills it mid-run and can leave the mice with Sidearm's signals) use the portable app's data: debug builds read `SIDEARM_DATA_DIR` (`paths.rs`), which `dev.ps1` sets to `..\portable\data`, so a test run drives the mice with the one real config. Close the portable Sidearm first (both hold `Local\Sidearm-app`). `dev.ps1` turns QuickEdit off in its console: the dev app logs to that console, and a click into it (a selection) blocks every write — the capture thread froze and every mouse button went silent. Before each (re)start `dev.ps1` stops the dev build's own app and capture helper (`src-tauri\target`); a restore process of it keeps running and the exe it holds is moved aside (`Move-LockedExe`), so the build can replace it.
- Whole-app check with virtual V2/V3 mice: `npm run e2e` (Windows; runs beside a running Sidearm, touches no real mouse; builds into `<CARGO_TARGET_DIR or src-tauri\target>\e2e`, so a worktree with the shared target dir set builds there; see `src-tauri/AGENTS.md`). Run it after any change to mouse, capture, exit or restore logic, before asking the owner to test on hardware; `npm run e2e -- --layout <config.json>` presses every V3 thumb assignment of a real config copy; `npm run e2e -- --popups` adds the real popup windows (on screen — run it while the keyboard can stay untouched for a minute).
- Main window in a browser with a fake backend (`tools/ui-check/`): `node tools/ui-check/make-config.mjs [<config.json>]` writes the gitignored `tools/ui-check/config.js` (`window.__UI_CONFIG__`; no argument = the seed config, through the ignored test `config::tests::write_seed_config_for_ui_check`; a real config is only ever copied there, never committed); serve the repo with Vite (`npx vite --port 45180 --strictPort` while the dev app holds 45173); then from the gitignored `output/` folder `playwright-cli open http://localhost:45180/` and `playwright-cli run-code --filename=../tools/ui-check/main-window.js` → `output/ui-check/main-1280x800.png`, plus the commands `mock.js` left unanswered (null) and page errors. `mock.js` is the init script that fakes `window.__TAURI_INTERNALS__` (config load/save, paths, runtime running, no mice, events via `window.__UI_CHECK__.emit`); add an answer there when a screen needs one. Native windows, the tray, popups and screen readers still need a manual pass in the running app.
- Memory/disk footprint: `pwsh -File tools\measure-footprint.ps1 -Exe <fake-mice sidearm.exe> [-Show] [-Runs 2]` — runs the exe from a temp portable folder with empty virtual mice and prints working set / private bytes of Sidearm and its WebView2 processes (hidden, shown without focus, hidden again) and the profile's biggest folders. Fake-mice builds only (it refuses others); build a release one with `cargo tauri build --no-bundle --features fake-mice` and `CARGO_TARGET_DIR=<target>\e2e`.
- `tools/fixtures/date-patterns.json` is the one list of date-pattern cases for both `input_synthesis::format_date_pattern` (Rust test, `include_str!`) and `formatDatePattern` (`src/lib/date-pattern.test.ts`): add a case there, never to one side.
- Tool regression checks: `node --test tools/e2e/run.test.mjs tools/licenses.test.mjs tools/workflows.test.mjs`. E2E fake-state edits hold the same OS file lock as Rust for the entire read/modify/write; dispatch assertions match one completed execution's action/profile/control/layer/key. `--layout` rejects an empty applicable assignment set before build/start. The workflow test checks the independently verified rust-cache commit pin offline.

## User Preferences

- Present non-trivial choices as numbered options with trade-offs; let the user pick.
- Diagnose to root cause before proposing fixes; explain what could break.
- Commit when authorized; do not push/merge/release without explicit approval.
- Run verification locally or on MiniPC. Do not start cloud CI jobs or add cloud verification gates; preserve cloud usage limits.
- Portable packaging intentionally stops every running Sidearm app on the build machine (the Sidearm whose parent is not a Sidearm and that is no `--restore-live-maps` process), whatever its executable path. Restore processes (`--restore-live-maps`: a watchdog, or the restorer a killed app's helper starts) are never stopped — one may wait hours for a sleeping mouse: an exe one still runs from is renamed to `<name>.old-<n>` (`tools/locked-exe.ps1` `Move-LockedExe`; Windows allows renaming a running exe) and the old copies nothing runs from any more are deleted; `release.ps1` leaves them out of the zip. Treat assembly as an interruption of those apps even when its output directory is isolated.
- Use computer control only for brief necessary UI actions. Release it before builds, transfers, analysis or waiting for the user.

## Child DOX Index

- `src/AGENTS.md` — React + TypeScript frontend (UI, pure logic, hooks, i18n)
- `src-tauri/AGENTS.md` — Rust + Tauri backend (capture, execution, config, Synapse import, mouse onboard memory, platform)
- `schemas/AGENTS.md` — the config JSON Schema contract (Rust ↔ schema ↔ TS)
- `plans/onboard-memory/2026-10-16-findings.md` — investigation ledger for the mouse onboard-memory and raw-HID work: measured hardware/registry facts, REA state, open questions, and traps already paid for
