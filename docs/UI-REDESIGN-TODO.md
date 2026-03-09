# UI Redesign Todo

- Scope: screen-by-screen UI cleanup after the second-pass shell rewrite
- Canonical planning source: `docs/PROJECT-BACKLOG.md`

## Objectives

1. make the app easier to understand than Synapse for the target workflow
2. reduce duplication
3. use Russian-first language
4. make the mouse the center of the experience
5. keep advanced tooling available but not forced

## Mode: `Назначения`

### BTN-001

- Goal: make the main screen feel like “choose button -> edit action”
- Priority: `P1`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Tasks:
  - reduce the number of visible right-column panels
  - keep `Свойства кнопки` as the primary detail panel
  - keep `Назначение кнопки` as the primary editor panel
  - avoid showing verification-only details here

### BTN-002

- Goal: simplify the surface cards even further
- Priority: `P1`
- Target files:
  - `src/App.tsx`
- Tasks:
  - keep only one main summary line and one secondary line
  - remove any remaining technical detail that belongs in advanced views
  - ensure selected-state is obvious without extra text

### BTN-003

- Goal: improve selected-control emphasis
- Priority: `P2`
- Target files:
  - `src/App.css`
- Tasks:
  - strengthen selected control visual state
  - make the active control easier to find in the scene
  - make selected state more distinct from verified state

## Mode: `Профили`

### PRO-001

- Goal: make the mode profile-first instead of surface-first
- Priority: `P1`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Tasks:
  - keep profile list visible
  - make profile editor the center of this mode
  - make app rules the second half of this mode
  - reduce surface prominence here

### PRO-002

- Goal: improve app-rule editing clarity
- Priority: `P1`
- Target files:
  - `src/App.tsx`
- Tasks:
  - rename remaining terms into user language
  - simplify explanatory text
  - improve empty state for profiles with no app rules

## Mode: `Проверка`

### VER-001

- Goal: turn the mode into a clear verification workflow
- Priority: `P1`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Tasks:
  - place selected control summary at the top
  - keep `Сигнал кнопки`, `Проверка кнопки`, `Фоновый перехват`, and `Проверка срабатывания`
  - remove or suppress unrelated editing tools

### VER-002

- Goal: make verification language explicit and user-readable
- Priority: `P1`
- Target files:
  - `src/App.tsx`
- Tasks:
  - stop saying “mapping” where “signal” or “observed signal” is enough
  - make button labels action-oriented
  - ensure the mode reads like a test flow, not an internal debugger

## Mode: `Эксперт`

### ADV-001

- Goal: concentrate heavy expert tooling here
- Priority: `P1`
- Target files:
  - `src/App.tsx`
- Tasks:
  - keep advanced action editing here
  - keep snippet library here
  - keep debug log here
  - keep persistence diagnostics here

### ADV-002

- Goal: keep advanced from feeling chaotic
- Priority: `P2`
- Target files:
  - `src/App.css`
- Tasks:
  - improve visual grouping of advanced sections
  - reduce visual competition between execution, log, and persistence panels

## Cross-cutting visual tasks

### VIS-REDO-001

- Goal: lower accent overload
- Priority: `P1`
- Target files:
  - `src/App.css`
- Tasks:
  - reduce saturated green backgrounds
  - keep one primary accent for action buttons and selection
  - make informational panels quieter

### VIS-REDO-002

- Goal: normalize vertical rhythm and form density
- Priority: `P2`
- Target files:
  - `src/App.css`
- Tasks:
  - normalize panel spacing
  - normalize field spacing
  - reduce crowding in the right column

### VIS-REDO-003

- Goal: prepare for a final mouse illustration pass
- Priority: `P2`
- Target files:
  - `src/App.tsx`
  - `src/App.css`
- Tasks:
  - preserve mouse-centric layout direction
  - keep thumb-grid transitional scene maintainable
  - avoid hard-coding a layout that blocks future illustration work

## Translation cleanup list

### TR-001

- Goal: remove remaining static English in `src/App.tsx`
- Priority: `P1`
- Target files:
  - `src/App.tsx`
- Notes:
  - user data from config is allowed to stay as-is
  - only static chrome and helper copy must be normalized

## Exit criteria for the redesign phase

The redesign phase is in good shape when:

1. `Назначения` mode feels focused and understandable
2. `Профили` mode feels profile-centered
3. `Проверка` mode feels like a verification workflow
4. `Эксперт` mode contains most expert-only complexity
5. static UI is consistently Russian
6. the mouse is clearly the center of the product experience
