# Contributing to Sidearm

Thanks for considering contributing! Here's how to get started.

## Development Setup

```bash
# Prerequisites
# - Node.js 20+
# - Rust 1.77+ (rustup.rs)
# - Windows 10/11

git clone https://github.com/danscMax/Sidearm.git
cd Sidearm
npm install
cargo tauri dev
```

## Project Structure

```
src/                  # React frontend (TypeScript)
  components/         # UI components
  hooks/              # React hooks
  lib/                # Utilities, types, helpers
src-tauri/            # Rust backend
  src/
    lib.rs            # IPC commands, app setup
    capture_backend.rs # Keyboard hook + foreground watcher
    executor.rs       # Action execution (shortcuts, macros, text)
    clipboard.rs      # Clipboard operations (STA thread)
    resolver.rs       # Profile/button resolution
    config.rs         # Config schema + validation
    input_synthesis.rs # SendInput wrapper
```

## Making Changes

1. Create a branch: `git checkout -b fix/description`
2. Make your changes
3. Run checks:
   ```bash
   npx tsc --noEmit        # TypeScript
   npx vitest run           # Frontend tests
   cargo test -p sidearm    # Rust tests
   ```
4. Commit with a clear message: `fix: description` or `feat: description`
5. Open a pull request

## Code Style

- **Rust**: standard `rustfmt`, no clippy overrides
- **TypeScript**: project tsconfig (strict, ES2022)
- **React**: functional components, hooks only, no Context API
- **Comments**: English in code, Russian in UI strings
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) format

## Reporting Bugs

Use the [Bug Report](https://github.com/danscMax/Sidearm/issues/new?template=bug_report.yml) issue template.

## Suggesting Features

Use the [Feature Request](https://github.com/danscMax/Sidearm/issues/new?template=feature_request.yml) issue template.
