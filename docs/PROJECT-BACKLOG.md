# Project Backlog

- Project: `Sidearm`
- Date: `2026-03-08`
- Status: canonical backlog and execution source of truth

## Purpose

This file is the primary planning document for the project.

Use it as the source of truth for:

- what the project is trying to achieve
- what is already complete
- what is still open
- what should be worked on next
- how work is prioritized

Secondary docs may summarize or expand on parts of this backlog, but they should not contradict it.

## Product Goal

Build a Windows desktop application for the Razer Naga V2 HyperSpeed that is easier to understand and faster to use than Razer Synapse for profile-aware mouse workflows.

The user should be able to:

1. choose a profile
2. choose a physical mouse control
3. understand what that control currently does
4. change the action quickly
5. verify that the real hardware signal matches the intended mapping

The product should not blindly copy Synapse.

It should be:

- more focused
- more understandable
- more mouse-centric
- more explicit about verification
- better at separating simple use from expert tools

## Current Snapshot

### Completed foundation

- Tauri v2 + React + TypeScript + Rust app is implemented
- config v2 storage, schema validation, semantic validation, atomic save, and backup are implemented
- editor shell exists for:
  - profiles
  - layers
  - controls
  - bindings
  - actions
  - snippets
  - app mappings
  - encoder mappings
- runtime exists for:
  - start / reload / stop
  - debug log
  - active window capture
  - resolution preview
  - dry-run execution
  - supported live execution
  - verification workflow

### Current UI state

- second-pass shell rewrite is implemented
- the app now has modes:
  - `Назначения`
  - `Профили`
  - `Проверка`
  - `Эксперт`
- the new shell now separates the main workflows more clearly:
  - `Назначения` keeps the device surface and fast assignment editing
  - `Профили` centers profile editing and app rules
  - `Проверка` centers verification session, signal checks, and runtime state
  - `Эксперт` contains heavy editing, snippets, diagnostics, and persistence
- `Проверка` now includes an MVP verification session with step-by-step evidence capture and JSON export
- the static UI is mostly Russian, but not fully normalized yet
- duplication was reduced again, but not fully resolved
- the thumb-grid view is more mouse-centric than before, but still not the final visual model

### Main unresolved areas

- final UX / visual design
- real-device validation
- Windows edge-case validation
- product hardening and release hygiene

## Working Rules

### Priorities

- `P0`: blocks correct product behavior or continuation
- `P1`: next highest-value work, should be done soon
- `P2`: important follow-up work
- `P3`: good improvements, but not urgent

### Status values

- `todo`
- `in_progress`
- `blocked`
- `done`
- `deferred`

### Recommended execution order

1. finish second-pass redesign cleanup
2. finalize Russian-first UX language
3. improve mouse-centric visual model
4. validate on the real device
5. validate Windows edge cases
6. harden packaging and repo hygiene

## Backlog

### UX / IA

#### UX-001

- Title: Finish Russian translation of static UI
- Priority: `P1`
- Status: `done`
- Why it exists: mixed-language UI still hurts clarity and perceived quality
- Dependencies: none
- Target files:
  - `src/App.tsx`
- Acceptance criteria:
  - all static section titles are Russian
  - all static button labels are Russian
  - all static helper text and empty states are Russian
  - user data stored inside config may remain unchanged

#### UX-002

- Title: Remove remaining internal-engineering jargon from user-facing sections
- Priority: `P1`
- Status: `done`
- Why it exists: terms like `config`, `runtime`, `mapping`, `actionRef`, and similar internal wording still leak into the normal UI
- Dependencies:
  - `UX-001`
- Target files:
  - `src/App.tsx`
  - `docs/UI-REDESIGN-TODO.md`
- Acceptance criteria:
  - primary UI paths use user language
  - advanced-only technical wording is kept only where it adds real diagnostic value
  - terminology is consistent across sections

#### UX-003

- Title: Reduce duplication between surface, control properties, verification, and preview
- Priority: `P1`
- Status: `done`
- Why it exists: the same meaning is still shown in multiple places
- Dependencies:
  - `UX-001`
  - `UX-002`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - the main surface shows only the minimum needed summary
  - `Свойства кнопки` does not repeat the same data shown on the surface unless detail is truly added
  - `Проверка` shows verification-specific data only
  - `Проверка срабатывания` does not restate surface data unless needed for debugging

#### UX-004

- Title: Tighten the right-column hierarchy in `Назначения` mode
- Priority: `P1`
- Status: `done`
- Why it exists: the right side still feels dense and visually flat
- Dependencies:
  - `UX-003`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - clear primary panel for the selected control
  - secondary panels are visually quieter
  - spacing and grouping are improved
  - the mode feels understandable without reading every panel

#### UX-005

- Title: Make `Профили` mode truly profile-centered
- Priority: `P1`
- Status: `done`
- Why it exists: `Профили` should not feel like a slightly modified surface screen
- Dependencies:
  - `UX-004`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - the main focus in `Профили` mode is profile management and app rules
  - surface-centric panels are minimized or removed in this mode
  - profile editing and app routing feel like one workflow

#### UX-006

- Title: Make `Проверка` mode verification-centered
- Priority: `P1`
- Status: `done`
- Why it exists: verification should be a clean, focused workflow
- Dependencies:
  - `UX-003`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - `Проверка` mode focuses on:
    - selected control
    - expected signal
    - observed signal
    - runtime state
    - verification actions
  - non-verification editors are minimized or removed

#### UX-007

- Title: Make `Эксперт` mode the only home for heavy debug and advanced editing
- Priority: `P1`
- Status: `done`
- Why it exists: advanced tools should not leak into simple workflows
- Dependencies:
  - `UX-004`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - debug log lives only in `Эксперт`
  - persistence diagnostics live only in `Эксперт` or where justified
  - heavy action details and snippet library are clearly advanced-oriented

#### UX-008

- Title: Replace weak free-form settings with stronger controls or better placement
- Priority: `P2`
- Status: `done`
- Why it exists: settings like `Тема` are currently vague and not product-ready
- Dependencies:
  - `UX-005`
- Target files:
  - `src/App.tsx`
- Acceptance criteria:
  - either the setting is removed from the normal UI
  - or it becomes a constrained, understandable control

### Visual design

#### VIS-001

- Title: Reduce green noise and normalize visual emphasis
- Priority: `P1`
- Status: `done`
- Why it exists: the interface still overuses green accents
- Dependencies: none
- Target files:
  - `src/App.css`
- Acceptance criteria:
  - one clear primary accent remains
  - neutral surfaces carry most of the UI
  - badges and active states no longer compete with primary actions

#### VIS-002

- Title: Make the mouse the visual center of `Назначения` mode
- Priority: `P1`
- Status: `done`
- Why it exists: the product should feel built around the real device
- Dependencies:
  - `UX-004`
  - `VIS-001`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Acceptance criteria:
  - the central device visualization dominates the workflow
  - selected control is visually obvious
  - the user can understand the current control without reading multiple panels

#### VIS-003

- Title: Design an original mouse illustration set
- Priority: `P2`
- Status: `deferred`
- Why it exists: current thumb scene is still a transitional solution
- Dependencies:
  - `VIS-002`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
  - optional future assets directory
- Acceptance criteria:
  - original mouse illustration or schematic exists
  - side keypad, top controls, wheel, and Hypershift are represented clearly
  - the design uses Razer geometry as reference, not as a direct copy

#### VIS-004

- Title: Normalize panel density, spacing, and vertical rhythm
- Priority: `P2`
- Status: `done`
- Why it exists: spacing still varies across heavy editor sections
- Dependencies:
  - `VIS-001`
- Target files:
  - `src/App.css`
- Acceptance criteria:
  - panel spacing is consistent
  - form spacing is consistent
  - the right column no longer feels visually compressed

### Runtime and verification

#### VERIFY-001

- Title: Validate top-panel controls on the real device
- Priority: `P1`
- Status: `done`
- Why it exists: top-panel control behavior is not fully trusted yet
- Dependencies:
  - a physical mouse session
- Target files:
  - `docs/DEVICE-VERIFICATION-MATRIX.md`
  - `docs/DEVICE-CATALOG.md`
  - seed config/status docs as needed
- Acceptance criteria:
  - top-panel controls are tested on hardware
  - statuses are updated to match observed reality
  - disagreements with the current seed are documented

#### VERIFY-002

- Title: Validate wheel controls on the real device
- Priority: `P1`
- Status: `done`
- Why it exists: wheel remapping confidence is still incomplete
- Dependencies:
  - a physical mouse session
- Target files:
  - `docs/DEVICE-VERIFICATION-MATRIX.md`
  - `docs/DEVICE-CATALOG.md`
- Acceptance criteria:
  - wheel up/down/click/left/right behavior is documented from live observation
  - seed statuses and notes are updated

#### VERIFY-003

- Title: Validate Hypershift edge cases on the real device
- Priority: `P1`
- Status: `done`
- Why it exists: Hypershift is one of the most important ambiguity zones
- Dependencies:
  - a physical mouse session
- Target files:
  - `docs/DEVICE-VERIFICATION-MATRIX.md`
  - `docs/DEVICE-CATALOG.md`
- Acceptance criteria:
  - Hypershift button behavior is documented from live testing
  - any ambiguous control interactions are recorded

#### VERIFY-004

- Title: Confirm final policy for reserved and risky controls
- Priority: `P2`
- Status: `done`
- Why it exists: some controls may need to remain reserved for safety
- Dependencies:
  - `VERIFY-001`
  - `VERIFY-002`
  - `VERIFY-003`
- Target files:
  - `docs/DEVICE-CATALOG.md`
  - `docs/CONFIG-SCHEMA-V2.md`
  - seed config/status docs as needed
- Acceptance criteria:
  - each risky control has a clear policy
  - reserved controls are documented as intentionally reserved, not “unknown”

#### VERIFY-005

- Title: Improve wording of verification UX based on live hardware evidence
- Priority: `P2`
- Status: `done`
- Why it exists: real-device testing should refine how the UI talks about confidence and evidence
- Dependencies:
  - `VERIFY-001`
  - `VERIFY-002`
  - `VERIFY-003`
- Target files:
  - `src/App.tsx`
  - `docs/RUNTIME-PIPELINE.md`
  - `docs/DEVICE-VERIFICATION-MATRIX.md`
- Acceptance criteria:
  - verification language matches real operational limits
  - user guidance is based on actual observed behavior, not only assumptions

### Windows/platform hardening

#### WIN-001

- Title: Validate behavior in elevated windows
- Priority: `P1`
- Status: `todo`
- Why it exists: UIPI may block input synthesis in higher-privilege targets
- Dependencies:
  - working runtime
- Target files:
  - `docs/RUNTIME-PIPELINE.md`
  - `docs/OPEN-ISSUES.md`
- Acceptance criteria:
  - elevated-window behavior is tested
  - limitations are documented clearly

#### WIN-002

- Title: Validate clipboard restore behavior across target applications
- Priority: `P2`
- Status: `todo`
- Why it exists: clipboard-preserving paste may still have edge cases
- Dependencies:
  - `WIN-001`
- Target files:
  - `docs/RUNTIME-PIPELINE.md`
  - `docs/OPEN-ISSUES.md`
- Acceptance criteria:
  - expected clipboard behavior is documented
  - failure modes are documented if they exist

#### WIN-003

- Title: Validate protected-window and security-boundary behavior
- Priority: `P2`
- Status: `todo`
- Why it exists: some targets may block input or behave differently
- Dependencies:
  - `WIN-001`
- Target files:
  - `docs/RUNTIME-PIPELINE.md`
  - `docs/OPEN-ISSUES.md`
- Acceptance criteria:
  - protected-window behavior is described
  - user-visible limitations are known

### Documentation and planning hygiene

#### DOC-001

- Title: Keep backlog as the single planning source of truth
- Priority: `P0`
- Status: `done`
- Why it exists: planning drift across documents wastes time
- Dependencies: none
- Target files:
  - `docs/PROJECT-BACKLOG.md`
  - `docs/PROJECT-HANDOFF-2026-03-08.md`
  - `README.md`
- Acceptance criteria:
  - `PROJECT-BACKLOG.md` is clearly identified as canonical
  - summary docs point back to it
  - no summary doc contradicts the backlog

#### DOC-002

- Title: Maintain a concrete open-issues list
- Priority: `P1`
- Status: `done`
- Why it exists: unresolved risks should not be scattered only through prose
- Dependencies: none
- Target files:
  - `docs/OPEN-ISSUES.md`
- Acceptance criteria:
  - open issues are listed with severity, impact, and next action
  - the list is easy to scan in a new chat

#### DOC-003

- Title: Maintain a detailed UI redesign todo
- Priority: `P1`
- Status: `done`
- Why it exists: UI backlog needs screen-level specificity
- Dependencies:
  - `DOC-001`
- Target files:
  - `docs/UI-REDESIGN-TODO.md`
- Acceptance criteria:
  - UI tasks are grouped by mode and component
  - each task names the likely target files

### Packaging and repo hardening

#### PACK-001

- Title: Fix Tauri bundle identifier ending with `.app`
- Priority: `P1`
- Status: `done`
- Why it exists: Tauri warns about the current identifier, and the current value is not ideal
- Dependencies: none
- Target files:
  - `src-tauri/tauri.conf.json`
  - docs that mention packaging identity
- Acceptance criteria:
  - bundle identifier no longer ends with `.app`
  - build warning disappears

#### PACK-002

- Title: Document repeatable release steps
- Priority: `P2`
- Status: `done`
- Why it exists: local builds work, but release procedure is not normalized
- Dependencies:
  - `PACK-001`
- Target files:
  - `README.md`
  - packaging docs if added later
- Acceptance criteria:
  - release build steps are documented
  - process-lock caveat is documented
  - output artifacts are named in docs

#### PACK-003

- Title: Decide whether to initialize git in this folder
- Priority: `P2`
- Status: `done`
- Why it exists: long-term project tracking is weaker without a repo
- Dependencies: none
- Target files:
  - docs only for now
- Acceptance criteria:
  - explicit decision is recorded
  - if yes, repo bootstrap steps are documented

## Active Focus

Completed: `UX-001` through `UX-008`, `VIS-001`, `VIS-002`, `VIS-004`, `PACK-001` through `PACK-003`, `VERIFY-001` through `VERIFY-005`.

Remaining items:

1. End-to-end action execution testing (shortcut, text snippet, sequence, launch)
2. `WIN-001` through `WIN-003` — Windows platform hardening

## Immediate Blockers

- none for code editing
- real-device validation tasks require the physical mouse
- `tauri build` can be blocked by the running exe until the process is stopped

## Related Documents

- summary: `README.md`
- current handoff: `docs/PROJECT-HANDOFF-2026-03-08.md`
- detailed UI tasks: `docs/UI-REDESIGN-TODO.md`
- unresolved issues: `docs/OPEN-ISSUES.md`

## Next Chat Prompt

```text
Open and use `docs/PROJECT-BACKLOG.md` as the canonical source of truth.
We are continuing Sidearm in `E:\Scripts\Razer Naga Studio`.
Read `docs/PROJECT-HANDOFF-2026-03-08.md`, `docs/UI-REDESIGN-TODO.md`, and `docs/OPEN-ISSUES.md` after that.
Start with the highest-priority open items unless I redirect you.
Before changing code, inspect the current `src/App.tsx` and `src/App.css`.
Keep the Russian-first, mode-based, mouse-centric direction.
Do not revert existing work.
```
