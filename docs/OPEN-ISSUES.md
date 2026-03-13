# Open Issues

- Status: active unresolved issues and risks
- Canonical planning source: `docs/PROJECT-BACKLOG.md`
- Updated: 2026-03-13

## P1

### WIN-001

- Area: Windows runtime
- Title: Elevated-window behavior is not yet validated
- Impact: `SendInput` fails silently in UIPI-protected targets (Task Manager, admin CMD, etc.)
- Next action:
  - test runtime against elevated windows
  - document limitations
  - add user-facing detection/warning

## P2

### WIN-002

- Area: Windows runtime
- Title: Clipboard restore behavior not validated across apps
- Impact: clipboard-paste fallback may fail or corrupt clipboard in edge cases
- Dependencies: WIN-001
- Next action:
  - test clipboard-paste in various apps (Office, terminals, browsers)
  - document failure modes

### WIN-003

- Area: Windows runtime
- Title: Protected-window and security-boundary behavior not validated
- Impact: some targets may block input or behave differently
- Dependencies: WIN-001
- Next action:
  - test against UAC prompts, lock screen, secure desktop
  - document user-visible limitations

### VIS-003

- Area: Visual design
- Title: Original mouse illustration set not yet designed
- Impact: current thumb-grid is transitional
- Status: deferred
- Next action:
  - design original Naga V2 schematic/illustration

## Closed since last update

- ISSUE-001 (UI Russian) — done (UX-001)
- ISSUE-002 (internal jargon) — done (UX-002)
- ISSUE-003 (duplication) — done (UX-003)
- ISSUE-004 (bundle identifier) — done (PACK-001)
- ISSUE-005..007 (hardware validation) — done (VERIFY-001..003)
- ISSUE-009 (build lock) — documented
- ISSUE-010 (git repo) — done (PACK-003)

## Notes

- These are issue summaries, not the canonical backlog.
- Use `docs/PROJECT-BACKLOG.md` for priorities, dependencies, and execution order.
