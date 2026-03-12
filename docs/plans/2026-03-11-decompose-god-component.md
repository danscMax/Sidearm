# Decompose God Component (App.tsx) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Break the 5431-line `App.tsx` God component into custom hooks and focused workspace components, targeting ~300 lines for the shell.

**Architecture:** Extract state+handlers into 3 custom hooks (persistence, runtime, verification), then split JSX into 4 workspace components + shared components (Sidebar, Toolbar, MouseVisualization). All hooks return plain objects consumed by components — no Context API needed since the shell wires everything together.

**Tech Stack:** React 19 (hooks, startTransition, useEffectEvent), TypeScript, Tauri v2

---

## File Map

```
src/
  App.tsx                         (~300 lines — shell, providers, routing)
  App.css                         (unchanged)
  hooks/
    useAppPersistence.ts          (config load/save, undo/redo, updateDraft)
    useRuntime.ts                 (start/stop/reload, listeners, debug, capture, preview)
    useVerification.ts            (session, step handlers, notes, export)
  components/
    Sidebar.tsx                   (nav, profile/layer selectors, runtime indicator)
    Toolbar.tsx                   (save, load, undo/redo, discard)
    MouseVisualization.tsx         (top+side views, hotspot buttons, multi-select)
    AssignmentsWorkspace.tsx       (device surface + binding editor + multi-select panel + control strip)
    ProfilesWorkspace.tsx          (profile editor + app routing)
    VerificationWorkspace.tsx      (device surface + verification panel + control properties + runtime)
    ExpertWorkspace.tsx            (action editor + snippets + signal + all service panels)
    ActionPickerModal.tsx          (already separate function, just move to file)
    CommandPalette.tsx             (already separate function, just move to file)
    ConfirmModal.tsx               (simple extraction)
    shared.tsx                     (Fact, PanelGroup, WarningsPanel, ErrorPanel)
  lib/
    constants.ts                  (hotspot maps, copy arrays, action categories)
    helpers.ts                    (label*, format*, parse*, describe*, with*Payload)
```

## Conventions

- No Context API — hooks return objects, shell passes props
- Each hook is a single function returning a typed object
- Workspace components receive a focused props interface, NOT the entire hook return
- Constants and pure helper functions go to `lib/constants.ts` and `lib/helpers.ts`
- CSS stays in one file (App.css) — no CSS changes in this plan
- Every task ends with `npx tsc --noEmit` passing

## Dependency Order

```
Task 1: lib/constants.ts + lib/helpers.ts (zero deps, pure extractions)
Task 2: hooks/useAppPersistence.ts (depends on lib/backend, lib/config-editing)
Task 3: hooks/useRuntime.ts (depends on lib/backend, lib/runtime)
Task 4: hooks/useVerification.ts (depends on lib/verification-session)
Task 5: components/shared.tsx (Fact, PanelGroup, WarningsPanel, ErrorPanel)
Task 6: components/ActionPickerModal.tsx + CommandPalette.tsx + ConfirmModal.tsx
Task 7: components/MouseVisualization.tsx
Task 8: components/Sidebar.tsx + Toolbar.tsx
Task 9: components/AssignmentsWorkspace.tsx
Task 10: components/ProfilesWorkspace.tsx
Task 11: components/VerificationWorkspace.tsx
Task 12: components/ExpertWorkspace.tsx
Task 13: Wire App.tsx shell (~300 lines)
Task 14: Final cleanup + verify
```

---

### Task 1: Extract Constants and Helpers

**Files:**
- Create: `src/lib/constants.ts`
- Create: `src/lib/helpers.ts`
- Modify: `src/App.tsx` — remove extracted code, add imports

**Step 1: Create `src/lib/constants.ts`**

Move these from App.tsx (lines 114-228, 152-200, 4067-4102) into the new file:
- `controlFamilyOrder`
- `workspaceModeCopy` (and its array element type → export `WorkspaceModeCopy`)
- `verificationScopeCopy`
- `topViewHotspots` + `sideViewHotspots` (and their record value type → export `HotspotPosition`)
- `layerCopy`
- `editableActionTypes`
- `ACTION_CATEGORIES` + `ActionCategory` type
- `MOUSE_ACTION_OPTIONS`
- `MEDIA_KEY_OPTIONS`
- Type aliases: `ViewState`, `WorkspaceMode`, `ControlSurfaceEntry`

Export all as named exports. Import types from `./config` and `./runtime` as needed.

**Step 2: Create `src/lib/helpers.ts`**

Move ALL pure functions from the bottom of App.tsx (after the App component closes at line ~4061) EXCEPT the component functions (ActionPickerModal, SequenceStepEditor, CommandPalette, PanelGroup, Fact, WarningsPanel, ErrorPanel). These are roughly lines 4771-5431:
- `resolveInitialProfileId`, `resolveInitialControlId`
- `sortAppMappings`
- `parseCommaSeparatedUniqueValues`, `parseCommaSeparatedList`, `parseCommaSeparatedTags`, `parseOptionalNumber`
- `describeActionSummary`, `describeVerificationAlignment`, `describeVerificationSessionSuggestion`
- `isActionLiveRunnable`
- `withShortcutPayload`, `withTextSnippetPayload`, `withSequencePayload`, `withLaunchPayload`, `withMenuPayload`
- `createDefaultSequenceStep`, `coerceSequenceStepType`, `setSequenceStepDelay`
- `collectMenuItemIds`, `appendMenuItem`, `updateMenuItem`, `removeMenuItem`
- `formatTimestamp`, `logLevelBadgeClass`
- All `labelFor*` functions (labelForLayer, labelForActionType, etc.)
- `actionCategoryIcon`
- `badgeClassForCapability`, `dotLabel`, `verificationResultColor`, `stateLabel`
- `surfacePrimaryLabel` (currently inside App function at line 1370 — move here too, it's pure)

Export all as named exports.

**Step 3: Update App.tsx imports**

Replace removed code with:
```typescript
import { controlFamilyOrder, workspaceModeCopy, ... } from "./lib/constants";
import { resolveInitialProfileId, formatTimestamp, ... } from "./lib/helpers";
```

Remove the moved lines from App.tsx.

**Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

**Step 5: Commit**

```bash
git add src/lib/constants.ts src/lib/helpers.ts src/App.tsx
git commit -m "refactor: extract constants and helpers from App.tsx"
```

---

### Task 2: Extract useAppPersistence Hook

**Files:**
- Create: `src/hooks/useAppPersistence.ts`
- Modify: `src/App.tsx` — replace state+handlers with hook call

**Step 1: Create `src/hooks/useAppPersistence.ts`**

This hook owns:
- **State:** `viewState`, `snapshot`, `workingConfig`, `lastSave`, `error`, `isDirty`, `undoStack`, `redoStack`
- **Functions:** `refreshConfig`, `persistConfig`, `updateDraft`, `resetDraft`, `handleUndo`, `handleRedo`
- **Derived:** `activeWarnings`, `activePath`, `activeConfig`

```typescript
import { startTransition, useState } from "react";
import type { AppConfig, CommandError, LoadConfigResponse, SaveConfigResponse, ValidationWarning } from "../lib/config";
import { loadConfig, saveConfig, reloadRuntime, normalizeCommandError } from "../lib/backend";
import type { ViewState } from "../lib/constants";

const MAX_UNDO = 15;

export interface AppPersistence {
  viewState: ViewState;
  activeConfig: AppConfig | null;
  activeWarnings: ValidationWarning[];
  activePath: string;
  isDirty: boolean;
  error: CommandError | null;
  snapshot: LoadConfigResponse | null;
  lastSave: SaveConfigResponse | null;
  undoStack: AppConfig[];
  redoStack: AppConfig[];
  setWorkingConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<CommandError | null>>;
  setViewState: React.Dispatch<React.SetStateAction<ViewState>>;
  refreshConfig: () => Promise<boolean>;
  persistConfig: (config: AppConfig) => Promise<void>;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  resetDraft: (confirmModal: (opts: { title: string; message: string; confirmLabel?: string; onConfirm: () => void }) => void) => void;
  handleUndo: () => void;
  handleRedo: () => void;
}

export function useAppPersistence(): AppPersistence { ... }
```

The hook body is the state declarations (lines 239-243, 249, 277-278) and functions (lines 505-636 of current App.tsx: refreshConfig, persistConfig, updateDraft, resetDraft, handleUndo, handleRedo).

Note: `resetDraft` currently calls `setConfirmModal` — instead, it should accept a `showConfirmModal` callback parameter so the hook doesn't own modal state.

Note: `persistConfig` calls `reloadRuntime` and sets `runtimeSummary` — extract the runtime reload as a returned Promise, and let the caller handle runtime refresh. Or: pass a `onConfigSaved` callback.

Actually simpler: `persistConfig` returns the saved config, and the hook internally reloads runtime. Since `setRuntimeSummary` belongs to useRuntime, we need a callback. Cleanest approach: `persistConfig` does NOT auto-reload runtime. The shell wires `persistConfig` to also call `runtime.reload()` after save.

**Step 2: Replace in App.tsx**

In the App function, replace the 8 state declarations and 6 functions with:
```typescript
const persistence = useAppPersistence();
const { activeConfig, isDirty, updateDraft, ... } = persistence;
```

Destructure the commonly used values for readability.

**Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/hooks/useAppPersistence.ts src/App.tsx
git commit -m "refactor: extract useAppPersistence hook"
```

---

### Task 3: Extract useRuntime Hook

**Files:**
- Create: `src/hooks/useRuntime.ts`
- Modify: `src/App.tsx`

**Step 1: Create `src/hooks/useRuntime.ts`**

This hook owns:
- **State:** `runtimeSummary`, `debugLog`, `captureDelayMs`, `lastCapture`, `resolutionKeyInput`, `lastResolutionPreview`, `lastExecution`, `lastRuntimeError`, `lastEncodedKey`
- **Functions:** `refreshDebugLog`, `handleStartRuntime`, `handleReloadRuntime`, `handleStopRuntime`, `handleCaptureActiveWindow`, `handlePreviewResolution`, `handleExecutePreviewAction`, `handleRunPreviewAction`
- **Effect listeners setup:** the useEffect that registers all Tauri event listeners (lines 411-447) and all useEffectEvent handlers (lines 359-409)

```typescript
export interface RuntimeControl {
  runtimeSummary: RuntimeStateSummary;
  debugLog: DebugLogEntry[];
  captureDelayMs: number;
  setCaptureDelayMs: (ms: number) => void;
  lastCapture: WindowCaptureResult | null;
  lastEncodedKey: EncodedKeyEvent | null;
  lastResolutionPreview: ResolvedInputPreview | null;
  lastExecution: ActionExecutionEvent | null;
  lastRuntimeError: RuntimeErrorEvent | null;
  resolutionKeyInput: string;
  setResolutionKeyInput: (key: string) => void;
  refreshDebugLog: () => Promise<void>;
  handleStartRuntime: () => Promise<void>;
  handleReloadRuntime: () => Promise<void>;
  handleStopRuntime: () => Promise<void>;
  handleCaptureActiveWindow: () => Promise<void>;
  handlePreviewResolution: () => Promise<void>;
  handleExecutePreviewAction: () => Promise<void>;
  handleRunPreviewAction: () => Promise<void>;
  setRuntimeSummary: React.Dispatch<React.SetStateAction<RuntimeStateSummary>>;
}

export function useRuntime(deps: {
  setError: (error: CommandError | null) => void;
}): RuntimeControl { ... }
```

The hook receives `setError` from persistence (since runtime errors display in the global error panel).

Note: `handleCaptureActiveWindow` uses `captureDelayMs` and `setLastCapture`. All internal.
Note: `handlePreviewResolution` and `handleExecutePreviewAction` use `resolutionKeyInput`. Internal.
Note: The Tauri listener setup effect belongs here since it sets runtime-owned state.

**Step 2: Replace in App.tsx**

```typescript
const runtime = useRuntime({ setError: persistence.setError });
```

**Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/hooks/useRuntime.ts src/App.tsx
git commit -m "refactor: extract useRuntime hook"
```

---

### Task 4: Extract useVerification Hook

**Files:**
- Create: `src/hooks/useVerification.ts`
- Modify: `src/App.tsx`

**Step 1: Create `src/hooks/useVerification.ts`**

This hook owns:
- **State:** `verificationSession`, `verificationScope`, `lastVerificationExportPath`
- **Functions:** `handleStartVerificationSession`, `handleRestartVerificationStep`, `handleVerificationResult`, `handleVerificationNotesChange`, `handleNavigateVerificationStep`, `handleReopenVerificationStep`, `handleResetVerificationSession`, `handleExportVerificationSession`
- **Derived:** `sessionSummary`, `currentVerificationStep`, `suggestedSessionResult`, `hasVerificationResults`
- **Effect:** sync selectedControlId/selectedLayer with active verification step (lines 340-357)

```typescript
export interface VerificationControl {
  verificationSession: VerificationSession | null;
  verificationScope: VerificationSessionScope;
  setVerificationScope: (scope: VerificationSessionScope) => void;
  lastVerificationExportPath: string | null;
  sessionSummary: ReturnType<typeof summarizeVerificationSession>;
  currentVerificationStep: ReturnType<typeof activeVerificationStep>;
  suggestedSessionResult: Exclude<VerificationStepResult, "pending"> | null;
  hasVerificationResults: boolean;
  handleStartVerificationSession: () => Promise<void>;
  handleRestartVerificationStep: () => void;
  handleVerificationResult: (result: Exclude<VerificationStepResult, "pending">) => void;
  handleVerificationNotesChange: (notes: string) => void;
  handleNavigateVerificationStep: (stepIndex: number) => void;
  handleReopenVerificationStep: (stepIndex: number) => void;
  handleResetVerificationSession: (showConfirm: (...) => void) => void;
  handleExportVerificationSession: () => Promise<void>;
}

export function useVerification(deps: {
  activeConfig: AppConfig | null;
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControlId: ControlId | null;
  setSelectedLayer: (layer: Layer) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  runtimeSummary: RuntimeStateSummary;
  handleStartRuntime: () => Promise<void>;
  lastEncodedKey: EncodedKeyEvent | null;
  lastCapture: WindowCaptureResult | null;
  lastResolutionPreview: ResolvedInputPreview | null;
  setError: (error: CommandError | null) => void;
}): VerificationControl { ... }
```

**Step 2: Replace in App.tsx and verify**

**Step 3: Commit**

```bash
git add src/hooks/useVerification.ts src/App.tsx
git commit -m "refactor: extract useVerification hook"
```

---

### Task 5: Extract Shared Components

**Files:**
- Create: `src/components/shared.tsx`
- Modify: `src/App.tsx`

**Step 1: Create `src/components/shared.tsx`**

Move from bottom of App.tsx:
- `PanelGroup` component (line ~4694)
- `Fact` component (line ~4728)
- `WarningsPanel` component (line ~4737)
- `ErrorPanel` component (line ~4753)

Export all as named exports.

**Step 2: Update App.tsx imports**

**Step 3: Verify + Commit**

```bash
git add src/components/shared.tsx src/App.tsx
git commit -m "refactor: extract shared components (Fact, PanelGroup, etc.)"
```

---

### Task 6: Extract Modal Components

**Files:**
- Create: `src/components/ActionPickerModal.tsx`
- Create: `src/components/CommandPalette.tsx`
- Create: `src/components/ConfirmModal.tsx`
- Modify: `src/App.tsx`

**Step 1: Move ActionPickerModal**

Move from App.tsx (lines ~4063-4499): the `ActionCategory` type, `ACTION_CATEGORIES`, `MOUSE_ACTION_OPTIONS`, `MEDIA_KEY_OPTIONS`, `ActionPickerModal` function, and `SequenceStepEditor` function. These are already self-contained with their own props interface.

**Step 2: Move CommandPalette**

Move from App.tsx (line ~4630): `PALETTE_COMMANDS` array and `CommandPalette` function.

Note: `PALETTE_COMMANDS` references `WorkspaceMode` type — import from constants.

**Step 3: Create ConfirmModal**

Extract the inline confirm modal JSX (currently rendered at the bottom of App's return, ~10 lines) into a simple component:

```typescript
export function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) { ... }
```

**Step 4: Verify + Commit**

```bash
git add src/components/ActionPickerModal.tsx src/components/CommandPalette.tsx src/components/ConfirmModal.tsx src/App.tsx
git commit -m "refactor: extract modal components"
```

---

### Task 7: Extract MouseVisualization

**Files:**
- Create: `src/components/MouseVisualization.tsx`
- Modify: `src/App.tsx`

**Step 1: Create MouseVisualization**

Move from App.tsx:
- `renderHotspotButtons` (lines 1382-1422)
- `renderMouseVisualization` (lines 1424-1473)

Convert to a proper component:

```typescript
import type { ControlSurfaceEntry } from "../lib/constants";
import { topViewHotspots, sideViewHotspots } from "../lib/constants";
import { surfacePrimaryLabel } from "../lib/helpers";

export function MouseVisualization({
  entries,
  selectedLayer,
  selectedControlId,
  multiSelectedControlIds,
  onSelectControl,
  onToggleMultiSelect,
}: {
  entries: ControlSurfaceEntry[];
  selectedLayer: Layer;
  selectedControlId: ControlId | null;
  multiSelectedControlIds: Set<ControlId>;
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
}) { ... }
```

**Step 2: Update App.tsx to use `<MouseVisualization ... />`**

**Step 3: Verify + Commit**

```bash
git add src/components/MouseVisualization.tsx src/App.tsx
git commit -m "refactor: extract MouseVisualization component"
```

---

### Task 8: Extract Sidebar and Toolbar

**Files:**
- Create: `src/components/Sidebar.tsx`
- Create: `src/components/Toolbar.tsx`
- Modify: `src/App.tsx`

**Step 1: Create Sidebar**

Extract the `<aside className="sidebar">...</aside>` block (lines ~1477-1575). Props:

```typescript
export function Sidebar({
  workspaceMode, onSwitchMode,
  profiles, effectiveProfileId, onSelectProfile,
  selectedLayer, onSelectLayer,
  isProfilesMode, showLayerRail,
  verificationSession,
  runtimeStatus, isDirty, viewState,
  onCreateProfile,
}: { ... }) { ... }
```

**Step 2: Create Toolbar**

Extract the `<div className="toolbar">...</div>` block (lines ~1578-1637). Props:

```typescript
export function Toolbar({
  heading,
  undoStack, redoStack,
  isDirty, viewState,
  onLoad, onUndo, onRedo, onDiscard, onSave,
}: { ... }) { ... }
```

**Step 3: Verify + Commit**

```bash
git add src/components/Sidebar.tsx src/components/Toolbar.tsx src/App.tsx
git commit -m "refactor: extract Sidebar and Toolbar components"
```

---

### Task 9: Extract AssignmentsWorkspace

**Files:**
- Create: `src/components/AssignmentsWorkspace.tsx`
- Modify: `src/App.tsx`

**Step 1: Create AssignmentsWorkspace**

This component renders the Assignments mode content:
- `showDeviceSurface` → MouseVisualization
- `showBindingEditor` → binding summary + assign/remove/copy buttons
- Multi-select panel (when multiSelectedControlIds > 0)
- `showControlStrip` → control strip list

Props interface includes: `activeConfig`, `effectiveProfileId`, `selectedLayer`, `selectedControl`, `selectedBinding`, `selectedAction`, `multiSelectedControlIds`, `familySections`, plus callbacks (`updateDraft`, `onSelectControl`, `onToggleMultiSelect`, `onOpenActionPicker`, etc.)

Move the JSX blocks guarded by `showDeviceSurface`, `showBindingEditor`, multi-select, and `showControlStrip` (when `isAssignmentsMode` is the condition).

**Step 2: Verify + Commit**

```bash
git add src/components/AssignmentsWorkspace.tsx src/App.tsx
git commit -m "refactor: extract AssignmentsWorkspace component"
```

---

### Task 10: Extract ProfilesWorkspace

**Files:**
- Create: `src/components/ProfilesWorkspace.tsx`
- Modify: `src/App.tsx`

**Step 1: Create ProfilesWorkspace**

This renders:
- `showProfileEditor` → profile name/description/priority/enabled/delete
- `showProfileRouting` → app mapping list + capture widget + mapping editor

Move JSX guarded by `showProfileEditor` and `showProfileRouting`.

Props: `activeConfig`, `activeProfile`, `selectedAppMapping`, `selectedAppMappings`, `lastCapture`, `updateDraft`, `isDirty`, callbacks for profile mutation.

**Step 2: Verify + Commit**

```bash
git add src/components/ProfilesWorkspace.tsx src/App.tsx
git commit -m "refactor: extract ProfilesWorkspace component"
```

---

### Task 11: Extract VerificationWorkspace

**Files:**
- Create: `src/components/VerificationWorkspace.tsx`
- Modify: `src/App.tsx`

**Step 1: Create VerificationWorkspace**

This renders:
- `showDeviceSurface` → MouseVisualization (shared with Assignments)
- `showControlProperties` → control info card
- `showVerificationPanel` → session UI (scope, progress, step, results)
- `showRuntimePanel` → start/stop/reload

Props: verification hook return, runtime hook return, selection state, activeConfig, familySections.

**Step 2: Verify + Commit**

```bash
git add src/components/VerificationWorkspace.tsx src/App.tsx
git commit -m "refactor: extract VerificationWorkspace component"
```

---

### Task 12: Extract ExpertWorkspace

**Files:**
- Create: `src/components/ExpertWorkspace.tsx`
- Modify: `src/App.tsx`

**Step 1: Create ExpertWorkspace**

This is the largest workspace. It renders:
- `showControlProperties` (shared with Verification)
- `showActionEditor` → full action editor with all payload types
- `showSnippetPanel` → snippet library CRUD
- `showSignalPanel` → encoder mapping editor
- `showRuntimePanel` (shared with Verification)
- `showWindowCapturePanel`, `showPreviewPanel`, `showExecutionPanel`, `showDebugPanel`, `showPersistencePanel`, `showSettingsPanel` — all service panels wrapped in PanelGroup

This component will be the largest (~1500 lines) but it contains only Expert mode concerns. The action editor section (~600 lines) could be further extracted later but is out of scope for this plan.

Props: activeConfig, updateDraft, selected control/binding/action/snippet/encoder, runtime hook return, persistence state.

**Step 2: Verify + Commit**

```bash
git add src/components/ExpertWorkspace.tsx src/App.tsx
git commit -m "refactor: extract ExpertWorkspace component"
```

---

### Task 13: Wire App.tsx Shell

**Files:**
- Modify: `src/App.tsx` — should now be ~300 lines

**Step 1: Verify App.tsx structure**

At this point App.tsx should contain:
1. Hook calls: `useAppPersistence()`, `useRuntime()`, `useVerification()`
2. Selection state: `selectedProfileId`, `selectedControlId`, `selectedLayer`, `multiSelectedControlIds`, `workspaceMode`
3. Derived values: profiles, activeProfile, effectiveProfileId, bindingByControlId, actionById, familySections, selectedControl/Binding/Action/Encoder/Snippet
4. Modal state: `actionPickerOpen`, `actionPickerBindingId`, `confirmModal`, `commandPaletteOpen`
5. `switchWorkspaceMode` function
6. Global keyboard shortcuts useEffect
7. Beforeunload useEffect
8. Init useEffect
9. JSX: `<Sidebar>` + `<Toolbar>` + workspace switch + modals

**Step 2: Clean up any remaining inline JSX**

Move any leftover inline JSX into the workspace components.

**Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

Run: `wc -l src/App.tsx` — should be ~250-350 lines.

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "refactor: App.tsx is now a thin shell (~300 lines)"
```

---

### Task 14: Final Cleanup and Verify

**Files:**
- All created files

**Step 1: Run full TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

**Step 2: Run `cargo tauri dev` smoke test**

Start the dev server, verify the app loads, switch between all 4 workspace modes, verify no console errors.

**Step 3: Check line counts**

```bash
wc -l src/App.tsx src/hooks/*.ts src/components/*.tsx src/lib/constants.ts src/lib/helpers.ts
```

Expected approximate distribution:
- `App.tsx`: ~300
- `hooks/useAppPersistence.ts`: ~150
- `hooks/useRuntime.ts`: ~250
- `hooks/useVerification.ts`: ~200
- `components/Sidebar.tsx`: ~100
- `components/Toolbar.tsx`: ~80
- `components/MouseVisualization.tsx`: ~120
- `components/AssignmentsWorkspace.tsx`: ~250
- `components/ProfilesWorkspace.tsx`: ~300
- `components/VerificationWorkspace.tsx`: ~400
- `components/ExpertWorkspace.tsx`: ~1500
- `components/ActionPickerModal.tsx`: ~500
- `components/CommandPalette.tsx`: ~80
- `components/ConfirmModal.tsx`: ~30
- `components/shared.tsx`: ~80
- `lib/constants.ts`: ~150
- `lib/helpers.ts`: ~700

**Step 4: Final commit**

```bash
git add -A
git commit -m "refactor: complete God component decomposition — App.tsx 5431→~300 lines"
```

---

## Risk Notes

1. **Stale closures**: Hook extraction naturally fixes stale closure risks because each hook manages its own state atoms with updater callbacks
2. **CSS**: All CSS stays in App.css — class names don't change, so no CSS risk
3. **Event listeners**: The Tauri listener setup (useEffect with cleanup) must stay in one place (useRuntime) to avoid double-registration
4. **startTransition**: Keep using startTransition in hooks — it's safe outside components
5. **useEffectEvent**: Must stay in hook bodies (React constraint), not in helper modules
6. **Circular deps**: hooks → lib is fine. components → hooks is fine via props. No component → component imports except shared.tsx.
