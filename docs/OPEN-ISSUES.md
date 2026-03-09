# Open Issues

- Status: active unresolved issues and risks
- Canonical planning source: `docs/PROJECT-BACKLOG.md`

## P1

### ISSUE-001

- Area: UI
- Title: Static UI is still not fully Russian
- Impact: mixed-language UI makes the product feel unfinished and less trustworthy
- Current evidence:
  - second-pass shell rewrite translated more of the shell
  - remaining strings still exist in `src/App.tsx`
- Next action:
  - complete `UX-001`

### ISSUE-002

- Area: UI / UX
- Title: Main flows still contain internal model language
- Impact: users are forced to think like the config model
- Current evidence:
  - signal / verification / action flows are improved but not fully normalized
- Next action:
  - complete `UX-002`

### ISSUE-003

- Area: UI / IA
- Title: Duplication remains between the surface, selected-control details, and verification
- Impact: users still re-read the same meaning in multiple places
- Current evidence:
  - second-pass shell rewrite reduced duplication again but did not finish the job
- Next action:
  - complete `UX-003`

### ISSUE-004

- Area: Packaging
- Title: Tauri bundle identifier ends with `.app`
- Impact: build warning remains and app identity is not ideal
- Current evidence:
  - `src-tauri/tauri.conf.json` uses `com.nagaworkflowstudio.app`
- Next action:
  - complete `PACK-001`

## P2

### ISSUE-005

- Area: Hardware validation
- Title: Top-panel controls are not fully validated on the real device
- Impact: statuses and trust levels may still be wrong
- Next action:
  - complete `VERIFY-001` using the in-app verification session

### ISSUE-006

- Area: Hardware validation
- Title: Wheel controls are not fully validated on the real device
- Impact: remapping confidence remains incomplete
- Next action:
  - complete `VERIFY-002` using the in-app verification session

### ISSUE-007

- Area: Hardware validation
- Title: Hypershift edge cases are not fully validated on the real device
- Impact: one of the most important behavior zones remains partly assumption-driven
- Next action:
  - complete `VERIFY-003` using the in-app verification session

### ISSUE-008

- Area: Windows runtime
- Title: Elevated-window behavior is not yet documented from live tests
- Impact: `SendInput` and related paths may fail in important targets
- Next action:
  - complete `WIN-001`

### ISSUE-009

- Area: Packaging
- Title: `tauri build` can fail when the release exe is still open
- Impact: rebuilds are easy to interrupt by accident
- Next action:
  - keep documenting this in release notes / handoff

### ISSUE-010

- Area: Repo hygiene
- Title: No git repository is initialized in the project folder
- Impact: change tracking and issue-driven workflow are weaker than they should be
- Next action:
  - complete `PACK-003`

## Notes

- These are issue summaries, not the canonical backlog.
- Use `docs/PROJECT-BACKLOG.md` for priorities, dependencies, and execution order.
