# UX Review: Naga Workflow Studio

Date: 2026-03-10
Reviewer: UX Designer (code-based review, no screenshots)
Scope: App.tsx (~4330 lines) + App.css (~1156 lines)

---

## Findings

### [MAJOR] UX-1: Verification session silently blocks layer switching with no explanation

**Location:** App.tsx:1331
**Element/Flow:** Layer toggle in sidebar during active verification session
**Category:** Feedback

**Problem:** When a verification session is active and not completed, the layer toggle buttons are disabled (`disabled={Boolean(verificationSession && !verificationSession.completedAt)}`), but there is zero visual or textual feedback explaining WHY the toggle is disabled. The buttons just go dim. A user in the middle of verification who wants to switch layers has no idea what to do.

**Grounding:**
- Line 1331: `disabled={Boolean(verificationSession && !verificationSession.completedAt)}`
- No tooltip, no notice, no explanatory text near the toggle
- User scenario: starts verification for Standard layer, realizes they need to check Hypershift, buttons are greyed out with no explanation

**Recommendation:** Add a tooltip or a small notice below the layer toggle when disabled: "Layer switching is locked during an active verification session. Complete or reset the session to switch." Alternatively, add a `title` attribute to the disabled buttons.

**Fix:** Add `title={verificationSession && !verificationSession.completedAt ? "Переключение слоя заблокировано во время сессии проверки" : layer.body}` to the layer toggle buttons at line 1331.

---

### [MAJOR] UX-2: "Create binding" is a dead-end if no actions exist yet

**Location:** App.tsx:2560-2575
**Element/Flow:** "Create binding" button in Assignments mode
**Category:** Flow

**Problem:** In Assignments mode, when a control has no binding, the user sees a "Create binding" button (`ensurePlaceholderBinding`). This creates a binding that references an action. But if the config has zero actions, the user will get a binding pointing to nothing, and the action dropdown (line 2530-2546) will be empty. There is no guard or guidance for this edge case.

**Grounding:**
- Line 2560-2575: button creates placeholder binding
- Line 2530-2546: action select dropdown populated from `availableActions`
- If `availableActions` is empty, the `<select>` renders with no `<option>` elements

**Recommendation:** Either (a) auto-create a default action when creating a placeholder binding, or (b) show a notice when there are no actions available, with a button to create one. The `ensurePlaceholderBinding` function in config-editing.ts likely handles this, but the UI should guard against the empty state.

**Fix:** Add a conditional check before the action `<select>` at line 2528: if `availableActions.length === 0`, show a notice with "No actions available. Create an action in Expert mode first."

---

### [MAJOR] UX-3: Runtime must be running for verification, but isDirty blocks runtime start -- circular dependency

**Location:** App.tsx:3130-3135, 2712-2728
**Element/Flow:** Runtime panel + Verification session start
**Category:** Flow

**Problem:** There is a circular dependency in the verification flow:
1. Runtime "Start" button is disabled when `isDirty` is true (line 3131)
2. Verification start button is disabled when `isDirty` is true (line 2728)
3. Verification auto-starts runtime if not running (line 972-984)
4. BUT: if user makes a change, saves, then immediately tries to start verification, and the save sets isDirty=false -- this works. However, if save fails (viewState becomes "error"), the user is stuck: isDirty is still true, can't start runtime, can't start verification, and must manually debug the error.

Additionally, the runtime "Start" button (line 3130-3135) is also blocked during `loading`/`saving` states. If a save operation hangs, the user is completely stuck.

**Grounding:**
- Line 3131: `isDirty || viewState === "loading" || viewState === "saving" || runtimeSummary.status === "running"`
- Line 2728: `disabled={isDirty}`
- Line 972: auto-start runtime inside `handleStartVerificationSession`

**Recommendation:** When verification start is blocked by isDirty, provide a combined "Save and Start Verification" button that chains both operations. This eliminates the two-step dance.

**Fix:** Add a compound action button when isDirty is true in the verification panel: "Save and start session" that calls `persistConfig` then `handleStartVerificationSession`.

---

### [MAJOR] UX-4: No confirmation before destructive "Reset session" action in verification

**Location:** App.tsx:2987-2995
**Element/Flow:** "Reset session" button during verification
**Category:** Flow

**Problem:** The "Reset session" button (`handleResetVerificationSession`) immediately destroys all verification progress (sets session to null) with no confirmation dialog. A user who has completed 15 of 20 verification steps and accidentally clicks this button loses all results.

**Grounding:**
- Line 1065-1070: `handleResetVerificationSession` sets `verificationSession` to null, `lastVerificationExportPath` to null
- Line 2987-2995: the button is styled as `action-button--ghost` which is the least prominent style, but it is still easily clickable and right next to "Export JSON"

**Recommendation:** Add a `window.confirm()` prompt before resetting, or implement a two-click pattern (first click changes label to "Are you sure?", second click executes). At minimum, check `hasVerificationResults` and only confirm if there are results.

**Fix:** Wrap `handleResetVerificationSession` in a confirm: `if (hasVerificationResults && !window.confirm("Сбросить сессию? Все результаты будут потеряны.")) return;`

---

### [MAJOR] UX-5: Profile routing panel depends on Window Capture data from Expert mode -- cross-mode hidden dependency

**Location:** App.tsx:1503-1522, 3205-3257
**Element/Flow:** "Create rule from capture" button in Profiles mode
**Category:** Discoverability

**Problem:** In Profiles mode, the "Create rule from capture" button (line 1503-1522) only appears when `lastCapture` is available. But the Window Capture panel (where you actually perform captures) is only visible in Expert mode (line 3205: `showWindowCapturePanel = isExpertMode`). A user in Profiles mode has no way to create a capture, no explanation of where to get one, and no link to the Expert mode capture tool. The button is just invisible.

**Grounding:**
- Line 1503: `{lastCapture && !lastCapture.ignored && activeProfile ? (`
- Line 1162: `const showWindowCapturePanel = isExpertMode;`
- User scenario: goes to Profiles, wants to create app-specific rule, has no capture data, sees no button, doesn't know capture exists

**Recommendation:** Either (a) show a disabled state with explanatory text: "Capture an active window in Expert mode first to auto-create rules", or (b) add a minimal capture button directly in the Profiles routing panel.

**Fix:** Below the route-list at line 1500, add a fallback when `!lastCapture`: `<p class="panel__muted">Use window capture in Expert mode to auto-create application rules, or add rules manually below.</p>`

---

### [MINOR] UX-6: Sequence step defaults use English text in Russian-first UI

**Location:** App.tsx:4003-4009
**Element/Flow:** Default values for new sequence steps
**Category:** Copy

**Problem:** When creating new sequence steps, the defaults are in English: `"Ctrl+C"`, `"Replace me"`, `"C:\\Path\\To\\App.exe"`. Since this is a Russian-first UI, these should be in Russian or at least use language-neutral examples.

**Grounding:**
- Line 4003: `{ type: "send", value: "Ctrl+C" }` -- this is fine (keyboard shortcuts are universal)
- Line 4005: `{ type: "text", value: "Replace me" }` -- should be Russian
- Line 4009: `{ type: "launch", value: "C:\\Path\\To\\App.exe" }` -- English path placeholder

**Recommendation:** Change to Russian placeholders: `"Replace me"` -> `"Замените этот текст"`, `"C:\\Path\\To\\App.exe"` -> `"C:\\Путь\\К\\Программе.exe"`.

**Fix:** Update lines 4005 and 4009 in `createDefaultSequenceStep`.

---

### [MINOR] UX-7: Action search filters the dropdown but doesn't indicate filtered state

**Location:** App.tsx:2516-2551
**Element/Flow:** Action search + action dropdown in Assignments mode
**Category:** Feedback

**Problem:** The action search field (line 2517-2525) filters the action dropdown below it. When a search term is active, the dropdown silently shows fewer options. The count "Matching: N" is shown at the bottom (line 2551), but there's no visual indication on the dropdown itself that it's filtered. A user might not realize they have a stale search term limiting their options.

**Grounding:**
- Line 2517: search input
- Line 2530-2546: filtered select
- Line 2551: `Suitable: {availableActions.length}. Bindings: {selectedActionUsageCount}.`
- Scenario: user searches, selects action, then later comes back -- search term persists until control/profile/layer changes (line 297-299), but within same selection it stays

**Recommendation:** Add a visual indicator on the search field when it has a value (e.g., a clear button), or add a badge on the dropdown label showing the filter count: "Action (3 of 15)".

**Fix:** Add a clear button inside the search field, and change the label at line 2529 to: `Действие {actionQuery ? `(${availableActions.length} из ${activeConfig?.actions.length ?? 0})` : ''}`

---

### [MINOR] UX-8: No empty state guidance in Profiles mode when no app mappings exist

**Location:** App.tsx:1621-1625
**Element/Flow:** App mapping list in Profiles mode
**Category:** Discoverability

**Problem:** When no app mappings exist for a profile, the message is: "This profile has no application rules yet." But there's no guidance on HOW to create one. The "Create rule from capture" button only appears when capture data exists. A user who hasn't used Expert mode capture has no visible way to create an app mapping.

**Grounding:**
- Line 1622: `<p className="panel__muted">This profile has no application rules yet.</p>`
- No "Add rule manually" button in this empty state
- The only creation path requires `lastCapture` to be non-null

**Recommendation:** Add a "Create rule manually" button in the empty state that creates a blank app mapping with a placeholder exe value. This provides an always-available creation path.

**Fix:** Add a button after the empty state message at line 1623 that calls `createAppMappingFromCapture` with placeholder values, or add a dedicated `createBlankAppMapping` function.

---

### [MINOR] UX-9: Verification progress dots have no label -- accessibility and discoverability issue

**Location:** App.tsx:2754-2775
**Element/Flow:** Verification progress bar dots
**Category:** Discoverability

**Problem:** The verification progress dots are small (20x20px) colored circles with only a `title` attribute for identification. While they do have `title={step.controlLabel: result}`, this requires hovering. With 12+ dots in a row, it's hard to tell which dot corresponds to which button, especially when many are the same color (e.g., all pending).

**Grounding:**
- Line 2756-2774: dots rendered as 20px circles
- CSS line 625-628: `width: 20px; height: 20px; border-radius: 50%;`
- For a session with 12 thumb buttons, user sees 12 identical circles with no labels

**Recommendation:** Add a short label (1-2 chars) inside each dot, matching the hotspot labels (1-12 for thumb grid, or abbreviations for top panel controls). The dots are big enough at 20px to hold a single digit.

**Fix:** Add inner text to the dots: `{step.controlLabel.replace(/^thumb_0?/, '').replace(/^(mouse|wheel|top).*/, firstChar)}` or similar abbreviation.

---

### [MINOR] UX-10: Layer toggle buttons during verification are disabled but Profile dropdown is not

**Location:** App.tsx:1295-1320 vs 1322-1343
**Element/Flow:** Sidebar profile selector during verification
**Category:** Consistency

**Problem:** During an active verification session, the layer toggle is correctly disabled (line 1331) because changing layers would invalidate the session. However, the profile dropdown (line 1295-1309) is NOT disabled. Changing profiles during verification would cause the binding/action data to change while the session tracks controls from the original profile. This is an inconsistent blocking pattern.

**Grounding:**
- Line 1331: layer toggle disabled during verification
- Line 1295-1309: profile selector has no verification guard
- Verification session stores `profileId` at creation (line 988-993 in `createVerificationSession`)
- Changing profile mid-session would show wrong binding data alongside verification steps

**Recommendation:** Disable the profile dropdown during active verification, matching the layer toggle behavior. Add same `disabled` condition.

**Fix:** Add `disabled={Boolean(verificationSession && !verificationSession.completedAt)}` to the profile `<select>` at line 1296.

---

### [MINOR] UX-11: "Reboot" button label in toolbar is ambiguous -- reload config vs refresh page

**Location:** App.tsx:1352-1361
**Element/Flow:** Toolbar "Reload" button
**Category:** Copy

**Problem:** The toolbar button labeled "Reload" (`refreshConfig`) reloads the config from disk. But "Reload" in a desktop app context could mean reload the entire application window. Combined with the "Reset" button next to it (which resets the draft), the labels are confusingly similar. "Reload" (reload from disk) vs "Reset" (reset to last loaded state) -- the semantic difference is subtle.

**Grounding:**
- Line 1360: "Reload" calls `refreshConfig()` -- reads config from file system
- Line 1365: "Reset" calls `resetDraft()` -- reverts to last loaded snapshot in memory
- Both buttons are secondary-styled, adjacent, with subtle distinction

**Recommendation:** Rename "Reload" to "Load from disk" or "Reload file" to distinguish from the in-memory reset. Change "Reset" to "Discard changes" for clarity.

**Fix:** Change line 1360 to "Load from disk" and line 1368 to "Discard changes".

---

### [MINOR] UX-12: Expert mode PanelGroup defaults to closed -- service tools invisible

**Location:** App.tsx:3203-3558
**Element/Flow:** Expert mode collapsible panel group
**Category:** Discoverability

**Problem:** The PanelGroup wrapping all expert service tools (Window Capture, Preview, Execution, Debug Log, Persistence, Settings) has `defaultOpen={false}` (the default). When a user switches to Expert mode, they see only the panels above the PanelGroup (Control Properties, Signal, Runtime). All service tools are collapsed behind a "Service tools" disclosure. First-time expert users may not discover these tools.

**Grounding:**
- Line 3204: `<PanelGroup title="Service tools">`
- Line 3582: `defaultOpen = false` in PanelGroup props
- These service tools include critical debugging features

**Recommendation:** Default to open for the Expert mode PanelGroup, since users explicitly chose Expert mode. Use `defaultOpen={true}` or set `defaultOpen` based on whether any service data exists (e.g., `lastCapture || debugLog.length > 0`).

**Fix:** Change line 3204 to `<PanelGroup title="Service tools" defaultOpen>`.

---

### [ENHANCEMENT] UX-13: No keyboard navigation for mouse visualization hotspots

**Location:** App.tsx:1183-1213
**Element/Flow:** Mouse hotspot buttons
**Category:** Flow

**Problem:** The mouse visualization hotspots are the primary way to select buttons in Assignments and Verification modes. While they are proper `<button>` elements (good), there's no keyboard shortcut or arrow-key navigation between hotspots. For a power-user tool about button remapping, keyboard-driven navigation would be valuable.

**Grounding:**
- Line 1191-1212: buttons rendered with absolute positioning
- No `onKeyDown` handler for arrow navigation
- Hotspots are in a flat list, no tab-order optimization

**Recommendation:** Add a keyboard handler that lets users navigate between hotspots with arrow keys when one is focused. Alternatively, add Ctrl+number shortcuts (1-12 for thumb grid).

---

### [ENHANCEMENT] UX-14: No unsaved changes warning on mode switch

**Location:** App.tsx:1278-1290
**Element/Flow:** Sidebar mode navigation
**Category:** Flow

**Problem:** When the user has unsaved changes (`isDirty`), switching between workspace modes (Assignments -> Profiles -> Verification -> Expert) does not warn about potential data context changes. While the draft persists across mode switches (good), some modes have different editing affordances, and verification mode specifically warns that it needs saved data. A user could make edits in Assignments, switch to Verification, and be confused when the "Start session" button is disabled.

**Grounding:**
- Line 1278-1290: mode switch with no guards
- Line 2712-2718: verification warns about dirty state but after mode switch
- Dirty status shown in sidebar footer (line 1344) but easy to miss

**Recommendation:** Make the dirty-state indicator more prominent when switching to Verification mode. Consider a brief inline notice at the top of the verification panel when isDirty is true, explaining the dependency.

---

### [ENHANCEMENT] UX-15: Debug log has no max height / virtualization -- potential scroll overflow

**Location:** App.tsx:3400-3415, CSS line 998-1015
**Element/Flow:** Debug log list in Expert mode
**Category:** CognitiveLoad

**Problem:** The debug log renders ALL entries in reverse order with no pagination, no max-height, and no virtualization. If the log accumulates hundreds of entries during a long session, this panel will grow unboundedly, pushing all panels below it out of view and causing performance issues.

**Grounding:**
- Line 3402: `{[...debugLog].reverse().map(...)}`
- CSS line 998: `.log-list` has no `max-height` or `overflow`
- No "clear log" or "load more" mechanism

**Recommendation:** Add `max-height: 400px; overflow-y: auto;` to `.log-list` in CSS, and add a "Clear log" button. For very large logs, consider showing only the last 50 entries with a "Show all" toggle.

**Fix:** Add to CSS: `.log-list { max-height: 400px; overflow-y: auto; }`

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| MAJOR | 5 |
| MINOR | 7 |
| ENHANCEMENT | 3 |

**Top priorities for immediate fix:**
1. UX-4: Add confirmation before verification session reset (easy fix, prevents data loss)
2. UX-1: Add tooltip to disabled layer toggle during verification (easy fix, eliminates confusion)
3. UX-10: Disable profile dropdown during verification (consistency fix, prevents data mismatch)
4. UX-5: Add empty-state guidance for app routing capture dependency (discoverability)
5. UX-3: Add combined "Save + Start verification" button (flow improvement)
