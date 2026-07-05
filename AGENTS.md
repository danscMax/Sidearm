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
- All user-facing text goes through i18next with matching `en.json` + `ru.json` keys — never hardcode UI strings.
- No AI/assistant attribution anywhere (commits, PRs, code, docs).
- Config is the source of truth: schema-first (`schemas/config.v2.schema.json` at the repo root, runtime-validated), atomic writes, rolling + daily backups, corrupt-recovery. The TS `AppConfig` (`src/lib/config.ts`) and Rust structs must stay in sync with the schema.
- Adding an `ActionType` touches many mirrored sites — see `src/components/action-picker/AGENTS.md`.
- Fix root causes, not symptoms. Reuse existing shared primitives/helpers before adding new ones.

## Verification

Run before declaring a code change done:

- Frontend: `npm run check` (= `tsc --noEmit` + `knip` dead-code + `cargo clippy`) and `npm run test` (vitest).
- Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml`.
- Integration smoke: `pwsh -File build_portable.ps1` (release build + WebView2 packaging; build via pwsh, not cmd).
- The desktop UI cannot be rendered headlessly here — visual and screen-reader changes need a manual pass in the running app.

## User Preferences

- Present non-trivial choices as numbered options with trade-offs; let the user pick.
- Diagnose to root cause before proposing fixes; explain what could break.
- Commit when authorized; do not push/merge/release without explicit approval.

## Child DOX Index

- `src/AGENTS.md` — React + TypeScript frontend (UI, pure logic, hooks, i18n)
- `src-tauri/AGENTS.md` — Rust + Tauri backend (capture, execution, config, Synapse import, platform)
- `schemas/AGENTS.md` — the config JSON Schema contract (Rust ↔ schema ↔ TS)
