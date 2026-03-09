# Naga Workflow Studio

Windows desktop application for configuring and executing profile-aware actions for the Razer Naga V2 HyperSpeed.

## Planning Source Of Truth

Use `docs/PROJECT-BACKLOG.md` as the canonical planning document.

For continuation context, use:

- `docs/PROJECT-HANDOFF-2026-03-08.md`
- `docs/UI-REDESIGN-TODO.md`
- `docs/OPEN-ISSUES.md`

## Stack

- Tauri v2
- Rust stable
- React + TypeScript + Vite

## Current State

The repository already contains:

- a working Tauri desktop app bootstrap
- architecture ADRs under `docs/adr/`
- config, device, runtime, and contract docs under `docs/`
- the v2 JSON Schema at `schemas/config.v2.schema.json`
- an implemented config-aware editor shell and Windows runtime path
- a second-pass 4-mode shell rewrite (`Назначения / Профили / Проверка / Эксперт`)
- the legacy AutoHotkey reference script at `Razer.ahk`

## Commands

```bash
npm install          # install frontend dependencies
npm run check        # TypeScript type-checking
npm run build        # Vite production build (frontend only)
npm run tauri dev    # start Tauri dev server (Vite on port 45173)
npm run tauri build  # full release build (NSIS installer + exe)
```

## Release Build

1. Close any running instance of the app (otherwise the build fails with `os error 5`).
2. Run:
   ```bash
   npm run tauri build
   ```
3. Output artifacts:
   - Installer: `src-tauri/target/release/bundle/nsis/Naga Workflow Studio_0.1.0_x64-setup.exe`
   - Standalone exe: `src-tauri/target/release/naga-workflow-studio.exe`
4. The installer uses the bundle identifier `com.nagaworkflowstudio.desktop`.

## Key Documents

- `docs/PROJECT-BACKLOG.md`
- `docs/PROJECT-HANDOFF-2026-03-08.md`
- `docs/UI-REDESIGN-TODO.md`
- `docs/OPEN-ISSUES.md`
- `docs/CONFIG-SCHEMA-V2.md`
- `docs/DEVICE-CATALOG.md`
- `docs/DEVICE-VERIFICATION-MATRIX.md`
- `docs/RUNTIME-PIPELINE.md`
- `docs/FRONTEND-BACKEND-CONTRACT.md`
