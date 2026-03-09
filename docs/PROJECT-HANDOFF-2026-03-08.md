# Project Handoff

- Project: `Naga Workflow Studio`
- Date: `2026-03-08`
- Workspace: `E:\Scripts\Razer Naga Studio`
- Status: working desktop app + runtime + second-pass shell rewrite; hardware validation and deeper UX cleanup remain open

## Canonical Source Of Truth

Use `docs/PROJECT-BACKLOG.md` as the canonical planning and execution document.

This handoff file is a continuation summary, not the primary backlog.

## Goal

Build a Windows desktop app for the Razer Naga V2 HyperSpeed that is easier to understand and use than Razer Synapse for the target workflow.

The product should let the user:

- choose a profile
- choose a mouse control
- see what that control does
- change the action quickly
- verify the real hardware signal when needed

The app should not blindly copy Synapse.

It should use the physical mouse as the center of the experience, while keeping expert tools available but not forced on every screen.

## Current Outcome

The project is already beyond planning.

It now has:

- a working Tauri v2 + React + TypeScript + Rust desktop app
- a persisted config store with JSON Schema validation and semantic validation
- a working editor shell for profiles, controls, bindings, actions, snippets, app mappings, and encoder mappings
- a Windows runtime path for capture, resolution, preview, live execution, and verification
- a second-pass shell rewrite that separates the app into clearer modes and reduces more duplication

## What Is Already Done

### Architecture and docs

- ADRs are present in `docs/adr/`
- system context, migration notes, schema docs, device catalog, runtime pipeline, and contract docs are present
- the v2 JSON Schema exists at `schemas/config.v2.schema.json`

### Persisted config

- config v2 is JSON-based, not INI-based
- load/save go through schema validation and semantic validation
- saves are atomic and keep a last-known-good backup
- seed data exists for profiles, actions, bindings, snippets, app mappings, and encoder mappings

### Frontend/editor shell

- profile list and profile editing
- layer switching
- control selection from the device surface
- binding editing
- full action editing for `shortcut`, `textSnippet`, `sequence`, `launch`, `menu`, `disabled`
- snippet library editing
- app mapping editing
- encoder mapping editing
- verification helpers

### Runtime/backend

- start/reload/stop runtime
- debug log retrieval
- active-window capture
- preview resolution
- dry-run action execution
- live execution for supported actions
- Windows `RegisterHotKey` capture backend
- Win32 `SendInput` path for shortcuts and text
- clipboard-preserving snippet paste path

### Shell redesign already applied

- main UI now has screen modes:
  - `Назначения`
  - `Профили`
  - `Проверка`
  - `Эксперт`
- many static UI labels were translated to Russian
- the new shell now makes `Назначения`, `Профили`, `Проверка`, and `Эксперт` visibly different workflows
- surface cards now show less duplicated technical detail
- the thumb-grid scene was restyled to be more mouse-centric
- visual green noise was reduced slightly

## What Is Not Done Yet

### Hardware validation

- real-device validation for top panel controls
- real-device validation for wheel controls
- real-device validation for ambiguous Hypershift behavior
- final policy for risky or reserved controls

### UX / visual design

- the redesign is still incomplete even after the second-pass shell rewrite
- there is still duplication and technical language in some places
- some sections are still heavier than they should be
- translation of static UI is not yet fully complete
- user data stored in config can still be English, and that is expected

### Product hardening

- no git repository is initialized in this folder yet
- release workflow is not formalized
- packaging works locally, but release process is not documented as a durable pipeline
- Tauri bundle identifier still ends with `.app` and should be cleaned up later

## Important Constraints and Decisions

- Stack is fixed for now:
  - Tauri v2
  - Rust
  - React + TypeScript + Vite
- Full control-based model is kept
- Hybrid discovery is kept
- Unknown hardware signals are not magically auto-discovered without seeded mappings
- The legacy `Razer.ahk` remains a migration reference, not the runtime foundation
- Do not copy Synapse directly
- Official Razer images can be used as reference, but shipped UI should prefer original illustrations/schematics

## Key Files

### Core UI

- `src/App.tsx`
- `src/App.css`

### Frontend types and helpers

- `src/lib/config.ts`
- `src/lib/runtime.ts`
- `src/lib/backend.ts`
- `src/lib/config-editing.ts`

### Rust backend

- `src-tauri/src/lib.rs`
- `src-tauri/src/config.rs`
- `src-tauri/src/runtime.rs`
- `src-tauri/src/executor.rs`
- `src-tauri/src/capture_backend.rs`
- `src-tauri/src/input_synthesis.rs`
- `src-tauri/src/clipboard.rs`

### Tauri config

- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

### Docs

- `docs/PROJECT-BACKLOG.md`
- `docs/CONFIG-SCHEMA-V2.md`
- `docs/DEVICE-CATALOG.md`
- `docs/DEVICE-VERIFICATION-MATRIX.md`
- `docs/RUNTIME-PIPELINE.md`
- `docs/FRONTEND-BACKEND-CONTRACT.md`

## How To Run

### Dev

```powershell
cd "E:\Scripts\Razer Naga Studio"
npm run tauri dev
```

Dev ports currently used:

- Vite: `45173`
- HMR: `45174`

### Release exe

```powershell
cd "E:\Scripts\Razer Naga Studio"
.\src-tauri\target\release\naga-workflow-studio.exe
```

### Build checks

```powershell
cd "E:\Scripts\Razer Naga Studio"
npm run check
npm run build
npm run tauri build
```

## Known Issues / Risks

1. The UI redesign is incomplete.
2. Static UI is not yet fully Russian everywhere.
3. The current verification flow still depends on seeded mappings.
4. Real hardware validation has not closed top/wheel/Hypershift questions.
5. `tauri build` warns that bundle identifier ends with `.app`.
6. If the release exe is running, `tauri build` can fail with `os error 5` until the process is stopped.

## Where To Continue

Primary planning:

- `docs/PROJECT-BACKLOG.md`

Detailed UI execution:

- `docs/UI-REDESIGN-TODO.md`

Current unresolved issues:

- `docs/OPEN-ISSUES.md`

## Recommended Order

1. Finish second-pass redesign cleanup
2. Mouse-centric visual redesign
3. Language and terminology cleanup
4. Real hardware validation
5. Windows/platform hardening
6. Packaging and repository hardening

## Good Next Chat Starting Point

Use this prompt in the next chat:

```text
Open and use `docs/PROJECT-BACKLOG.md` as the canonical source of truth.
We are continuing Naga Workflow Studio in `E:\Scripts\Razer Naga Studio`.
Read `docs/PROJECT-HANDOFF-2026-03-08.md`, `docs/UI-REDESIGN-TODO.md`, and `docs/OPEN-ISSUES.md` after that.
Start with the highest-priority open items unless I redirect you.
Before changing code, inspect the current `src/App.tsx` and `src/App.css`.
Keep the 4-mode shell direction, Russian-first interface, and mouse-centric redesign.
Do not revert existing work. Continue from the current second-pass shell rewrite.
```

## One-Line Status

The project already works, but the next real value is in finishing the shell redesign cleanly and then validating the mouse on real hardware.
