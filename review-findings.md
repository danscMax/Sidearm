# Code Review: Razer Naga Studio (App.tsx, verification-session.ts, config-editing.ts)

## Summary: 12 findings -- 3 blockers, 6 warnings, 3 info

---

### [BLOCKER] B-001: Stale closure in `updateSelectedActionDraft` captures outdated `selectedAction`

**File:** App.tsx:516-522
**Category:** Correctness

**Defect:** `updateSelectedActionDraft` reads `selectedAction` from the render closure, not from the latest state. When called, `selectedAction` is derived from `workingConfig` at render time, but `updateDraft` uses a state updater callback `(config) => ...`. If multiple rapid updates happen in the same render cycle (or within `startTransition`), the `selectedAction` object will be stale -- it reflects the config at the time the component last rendered, not the current in-flight state. This means the second call will overwrite the first call's changes by spreading from the old `selectedAction`.

**Grounding:**
- Code: App.tsx:516-522 -- `updateSelectedActionDraft` calls `updateDraft((config) => upsertAction(config, updateAction(selectedAction)))`. The `config` parameter is fresh from the updater, but `selectedAction` is captured from the outer closure.
- Context: This is called from many event handlers (modifier checkboxes at lines 1722-1728, shortcut key input at 1693-1698, etc.). If a user quickly toggles two modifier checkboxes, the second toggle may overwrite the first because `selectedAction` still has the old modifier state.

**Fix:** Re-derive the action from the `config` parameter inside the updater:
```tsx
function updateSelectedActionDraft(updateAction: (action: Action) => Action) {
  if (!selectedBinding) return;
  const actionRef = selectedBinding.actionRef;
  updateDraft((config) => {
    const currentAction = config.actions.find(a => a.id === actionRef);
    if (!currentAction) return config;
    return upsertAction(config, updateAction(currentAction));
  });
}
```

---

### [BLOCKER] B-002: Stale closure in `updateSelectedSnippetDraft` captures outdated `selectedSnippet`

**File:** App.tsx:636-646
**Category:** Correctness

**Defect:** Same pattern as B-001. `updateSelectedSnippetDraft` captures `selectedSnippet` from the render closure. If two snippet fields are edited in rapid succession, the second edit overwrites the first.

**Grounding:**
- Code: App.tsx:636-646 -- `updateDraft((config) => upsertSnippetLibraryItem(config, updateSnippet(selectedSnippet)))` where `selectedSnippet` is from the closure.
- Context: Used for name, text, pasteMode, tags, and notes editing of snippets (lines 2263-2331). All use the same stale reference.

**Fix:** Re-derive the snippet from config inside the updater:
```tsx
function updateSelectedSnippetDraft(updateSnippet: (s: SnippetLibraryItem) => SnippetLibraryItem) {
  if (!selectedSnippet) return;
  const snippetId = selectedSnippet.id;
  updateDraft((config) => {
    const current = config.snippetLibrary.find(s => s.id === snippetId);
    if (!current) return config;
    return upsertSnippetLibraryItem(config, updateSnippet(current));
  });
}
```

---

### [BLOCKER] B-003: Stale closure in `handleVerificationResult` reads stale `currentVerificationStep` and `lastCapture`/`lastResolutionPreview`

**File:** App.tsx:1014-1039
**Category:** Correctness

**Defect:** `handleVerificationResult` reads `currentVerificationStep`, `lastEncodedKey`, `lastCapture`, and `lastResolutionPreview` from the render closure, then passes them into `setVerificationSession((currentSession) => ...)`. The session updater receives the fresh session, but the capture/preview/notes data used in `finalizeVerificationStep` is from the stale render closure. If a key event arrives between the last render and the button click, the data will be inconsistent.

More critically, `currentVerificationStep?.notes` at line 1034 is the notes value from the LAST RENDER. If the user types notes and immediately clicks "Matched" before re-render, the notes are lost.

**Grounding:**
- Code: App.tsx:1014-1039 -- `captureForStep` and `previewForStep` are computed from closure variables, then passed to `finalizeVerificationStep` inside a state updater.
- Code: App.tsx:1034 -- `currentVerificationStep?.notes` is stale.

**Fix:** Move the data extraction inside the state updater callback, deriving `currentVerificationStep` from `currentSession`:
```tsx
function handleVerificationResult(result: ...) {
  setVerificationSession((currentSession) => {
    if (!currentSession) return currentSession;
    const step = activeVerificationStep(currentSession);
    const captureForStep = step?.observedAt && lastEncodedKey?.receivedAt === step.observedAt ? lastCapture : null;
    const previewForStep = step?.observedAt && lastEncodedKey?.receivedAt === step.observedAt ? lastResolutionPreview : null;
    return finalizeVerificationStep(currentSession, result, captureForStep, previewForStep, step?.notes);
  });
}
```
Note: `lastEncodedKey`, `lastCapture`, `lastResolutionPreview` are still from closure but these are separate state atoms that are less likely to be stale at the same time. The critical fix is reading `step` from `currentSession`.

---

### [WARNING] W-001: Verification session not invalidated when config changes or layer switches

**File:** App.tsx:252, App.tsx:466-477
**Category:** DataIntegrity

**Defect:** When `updateDraft` is called, it modifies the working config, but any active `verificationSession` still holds stale `configuredEncodedKey` and `expectedEncodedKey` values from when the session was created. If a user edits encoder mappings mid-verification, the session steps will show outdated "Configured" values and the match logic will compare against old data.

Similarly, the layer toggle is disabled during an active session (line 1331), but the profile selector is NOT disabled. Switching profiles mid-session will change bindings/encoders but not update the session.

**Grounding:**
- Code: App.tsx:1331 -- layer toggle `disabled={Boolean(verificationSession && !verificationSession.completedAt)}`
- Code: App.tsx:1296-1309 -- profile selector has no such guard
- Code: verification-session.ts:106-125 -- step data is snapshotted at creation time

**Fix:** Either (a) disable the profile selector during active verification sessions, or (b) invalidate/reset the verification session when the profile changes. Option (a) is simpler:
```tsx
// In profile <select>:
disabled={Boolean(verificationSession && !verificationSession.completedAt)}
```

---

### [WARNING] W-002: `ensurePlaceholderBinding` may create duplicate actions when action already exists but binding does not

**File:** config-editing.ts:380-415
**Category:** DataIntegrity

**Defect:** At line 381, `actionId` is set to `baseActionId` if an action with that ID already exists. But at line 413, when adding a new action, the code adds it to `config.actions` using spread. However, `upsertBinding` at line 412 gets the config WITHOUT the new action, and then line 413 spreads `config.actions` (the ORIGINAL config, not the one returned by `upsertBinding`).

Wait -- actually looking more carefully: line 412 calls `upsertBinding(config, nextBinding)` which returns a NEW config with the binding added. Then line 413 spreads `...upsertBinding(config, nextBinding)` and overrides `actions` with `[...config.actions, nextAction]`. But `config.actions` here is the ORIGINAL config's actions, not the one from `upsertBinding`. Since `upsertBinding` only modifies `bindings`, this is actually fine -- `config.actions` is the same in both. However, the pattern is fragile and could break if `upsertBinding` ever modified actions too.

The real issue: line 381-383 uses `baseActionId` when an action exists, but line 385 uses `nextUniqueId` for the binding. This means if you call `ensurePlaceholderBinding` twice for the same control (e.g., different profiles), the binding ID will get `-2` suffix but both will reference the same action. This is actually intended behavior (action sharing). Not a bug. Withdrawing this finding.

---

### [WARNING] W-002: `handleCreateProfile` mutates state inside `setWorkingConfig` updater by calling `setSelectedProfileId`

**File:** App.tsx:491-514
**Category:** Correctness

**Defect:** Inside the `setWorkingConfig` updater callback (lines 491-510), the code calls `startTransition(() => setSelectedProfileId(nextProfile.id))` at line 504-506. React state updater functions should be pure -- they should not trigger side effects like setting other state. While React likely processes this correctly in practice (the nested setState is batched), it violates the React contract for updater functions and could cause unexpected behavior in concurrent mode.

**Grounding:**
- Code: App.tsx:491-510 -- `setWorkingConfig((currentConfig) => { ... setSelectedProfileId(...) ... return nextConfig; })`
- Context: React docs state updater functions must be pure.

**Fix:** Extract the profile creation and selection into separate sequential steps:
```tsx
function handleCreateProfile() {
  if (!workingConfig) return;
  const nextConfig = createProfile(workingConfig, "...");
  const nextProfile = nextConfig.profiles.find(p => !workingConfig.profiles.some(cp => cp.id === p.id));
  setWorkingConfig(nextConfig);
  if (nextProfile) setSelectedProfileId(nextProfile.id);
  setIsDirty(true);
}
```

---

### [WARNING] W-003: `suggestedVerificationStepResult` in verification-session.ts compares against wrong control/layer

**File:** verification-session.ts:247-270, App.tsx:777-782
**Category:** Correctness

**Defect:** `suggestedVerificationStepResult` (verification-session.ts:247) takes `selectedControlId` and `selectedLayer` and compares them against the step's resolved control/layer. But in App.tsx:777-782, `deriveVerificationSessionResult` is called instead (App.tsx:3849), passing `lastResolutionPreview` from the global state. The `suggestedVerificationStepResult` function in verification-session.ts is never actually called from App.tsx -- it is dead code. The duplicate logic in `deriveVerificationSessionResult` (App.tsx:3849-3873) uses `preview?.controlId` and `preview?.layer` which are from the global `lastResolutionPreview` state, not from the step's own stored resolution data.

This means: if a key event arrives for button X while the user is verifying button Y, the suggestion will use button X's resolution data, potentially showing "matched" when it shouldn't.

**Grounding:**
- Code: verification-session.ts:247-270 -- `suggestedVerificationStepResult` (unused)
- Code: App.tsx:3849-3873 -- `deriveVerificationSessionResult` uses global `lastResolutionPreview`
- Code: App.tsx:777-782 -- called with `lastResolutionPreview`, `selectedControlId`, `selectedLayer`

**Fix:** Use the step's own stored resolution data (`step.resolvedControlId`, `step.resolvedLayer`) instead of global state. Or use the existing `suggestedVerificationStepResult` from verification-session.ts and remove the duplicate.

---

### [WARNING] W-004: `formatTimestamp` treats `0` as falsy, shows "n/a" for epoch zero

**File:** App.tsx:4137-4143
**Category:** Correctness

**Defect:** `formatTimestamp` uses `if (!timestamp)` which is falsy for `0`. A timestamp of `0` (January 1, 1970) would show "n/a" instead of the actual date. While unlikely in practice, this is a correctness issue since `timestamp` is typed as `number | null`.

**Grounding:**
- Code: App.tsx:4137-4143 -- `if (!timestamp)` returns "n/a"

**Fix:** Use `if (timestamp === null || timestamp === undefined)` or `if (timestamp == null)`.

---

### [WARNING] W-005: Verification session uses `selectedControlId` and `selectedLayer` from closure in step sync effect, creating potential infinite re-render loop

**File:** App.tsx:301-318
**Category:** Correctness

**Defect:** The effect at line 301-318 syncs `selectedControlId` and `selectedLayer` with the active verification step. The dependency array includes `[selectedControlId, selectedLayer, verificationSession]`. When the effect runs and sets `selectedControlId` via `setSelectedControlId`, it changes the dependency, which re-triggers the effect. This is normally safe because the second run would find the values already match and do nothing. However, during `startTransition`, the deferred update scheduling might cause extra re-renders.

More importantly, if the verification session's active step has a `controlId` that doesn't exist in the physical controls (e.g., after config reload that removed a control), this effect will set `selectedControlId` to a value that will fail the guard in the next effect (lines 282-295), which will reset it to the initial control, which will re-trigger this effect, creating an oscillation.

**Grounding:**
- Code: App.tsx:301-318 -- effect syncing verification step
- Code: App.tsx:282-295 -- effect resetting invalid control
- Context: These two effects can conflict if a verification step references a removed control.

**Fix:** Add a guard to check the control exists before syncing:
```tsx
if (activeStep && activeConfig?.physicalControls.some(c => c.id === activeStep.controlId)) {
  // sync
}
```

---

### [INFO] I-001: Dead code -- `suggestedVerificationStepResult` in verification-session.ts is never called

**File:** verification-session.ts:247-270
**Category:** CodeQuality

**Defect:** This function is exported but never imported or called anywhere. App.tsx defines its own `deriveVerificationSessionResult` at line 3849 which duplicates the logic with slightly different parameters.

**Grounding:**
- Grep shows no imports of `suggestedVerificationStepResult` in App.tsx (it imports many other functions from the module but not this one).
- Code: verification-session.ts:247-270

**Fix:** Either remove the dead code or replace `deriveVerificationSessionResult` with it.

---

### [INFO] I-002: God component -- App function is ~3350 lines with all state, handlers, and rendering in one function

**File:** App.tsx:227-3578
**Category:** CodeQuality

**Defect:** The `App` component contains ~30 state variables, ~20 handler functions, ~10 derived values, and the entire rendering tree for all workspace modes. This makes it extremely difficult to reason about stale closures (as evidenced by B-001/B-002/B-003), test individual sections, or add features without risk of regression.

**Grounding:**
- Code: App.tsx:227-3578 -- single function component
- Context: The stale closure bugs found in this review are a direct consequence of this architecture.

**Fix:** Extract workspace modes into separate components (VerificationWorkspace, ProfilesWorkspace, etc.) and use a reducer or context for shared state. At minimum, extract the verification session logic into a custom hook.

---

### [INFO] I-003: Profile sort in `profiles` derivation may crash if `name` is undefined

**File:** App.tsx:648-653
**Category:** Correctness

**Defect:** The sort comparator uses `(left.name ?? left.id).localeCompare(right.name ?? right.id)`. Looking at the Profile type (config.ts:69-75), `name` is typed as `string` (not optional), so the `?? left.id` fallback is unnecessary but harmless. However, the defensive `??` suggests there may have been cases where `name` was undefined. If the type is wrong and `name` CAN be undefined at runtime (e.g., from malformed JSON), this is correctly handled. Not a bug, just noting the defensive pattern.

**Grounding:**
- Code: App.tsx:648-653 -- sort with `?? left.id` fallback
- Code: config.ts:69-75 -- `name: string` (required)

**Fix:** No action needed. The defensive coding is fine.

---

### [WARNING] W-006: `parseCommaSeparatedUniqueValues` strips values while user is still typing, breaking mid-edit

**File:** App.tsx:3664-3678, App.tsx:1581-1583
**Category:** Correctness / UX

**Defect:** When editing the "title includes" filter (line 1578-1593), every keystroke triggers `parseCommaSeparatedUniqueValues` which trims whitespace and filters empty strings. This means if a user types "hello, " and pauses, the trailing space is stripped and the input value becomes "hello" (joined back), removing their cursor position after the comma. The same issue affects tags editing.

However, looking more carefully: the parsed result is stored via `updateDraft` into the config object (as `titleIncludes` array), and the display value is `(selectedAppMapping.titleIncludes ?? []).join(", ")`. So the value shown is the re-joined version, which does strip trailing commas/spaces. This means a user cannot type a comma followed by a new value -- as soon as they type the comma, it gets parsed as ["hello", ""] -> ["hello"], displayed as "hello", losing the comma.

**Grounding:**
- Code: App.tsx:1578-1593 -- titleIncludes input with onChange parsing
- Code: App.tsx:3664-3678 -- `parseCommaSeparatedUniqueValues` filters empty strings

**Fix:** Use a local input state (like `actionQuery` at line 236) that stores the raw text, and only parse on blur or on a debounce. Or accept the raw string as-is and parse only when saving.
