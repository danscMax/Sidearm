# Frontend Refactoring: DRY-up & Module Split

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate duplicated code, split the 735-line helpers.ts god-file into domain modules, and reduce boilerplate in useRuntime hook.

**Architecture:** Pure extract-and-move refactoring. No behavioral changes. Every import is mechanically updated. Tests must pass after each task.

**Tech Stack:** React 19, TypeScript 5.8, Vitest 4, Vite 7

**Verification command:** `npx vitest run` (from project root)
**Type-check command:** `npx tsc --noEmit`

---

### Task 1: Delete duplicate `collectMenuActionRefs` from ProfilesWorkspace

**Evidence:**
- Original: `src/lib/config-editing.ts:805-813` — private function, also used at line 650
- Duplicate: `src/components/ProfilesWorkspace.tsx:1004-1015` — local copy, used at line 575
- Both are identical in logic (iterate MenuItem[], add actionRef to Set recursively)

**Files:**
- Modify: `src/lib/config-editing.ts` — export the function
- Modify: `src/components/ProfilesWorkspace.tsx` — delete local copy, import from config-editing

**Step 1: In `config-editing.ts`, change `function` to `export function` on line 805**

```typescript
// Before (line 805):
function collectMenuActionRefs(items: MenuItem[], refs: Set<string>): void {

// After:
export function collectMenuActionRefs(items: MenuItem[], refs: Set<string>): void {
```

**Step 2: In `ProfilesWorkspace.tsx`, add import and delete local copy**

Add `collectMenuActionRefs` to the import from `../lib/config-editing` (line 8-16).

Delete lines 1003-1015 (the local `collectMenuActionRefs` function).

**Step 3: Run tests and type-check**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: all pass, no type errors.

**Step 4: Commit**

```bash
git add src/lib/config-editing.ts src/components/ProfilesWorkspace.tsx
git commit -m "refactor: deduplicate collectMenuActionRefs — export from config-editing"
```

---

### Task 2: Fix Sidebar.tsx local Profile type — import from config.ts

**Evidence:**
- `src/components/Sidebar.tsx:9-12` defines `interface Profile { id: string; name: string; }`
- `src/lib/config.ts:74-81` defines the canonical `Profile` with `id, name, description?, enabled, priority`
- Sidebar only uses `.id` and `.name` on profiles — structural subtyping makes the canonical type work
- Sidebar already imports `AppConfig` from `../lib/config` (line 5)

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: Add `Profile` to existing config import, delete local interface**

```typescript
// Before (line 5):
import type { AppConfig } from "../lib/config";

// After:
import type { AppConfig, Profile } from "../lib/config";
```

Delete lines 9-12 (local `interface Profile { ... }`).

**Step 2: Run type-check**

```bash
npx tsc --noEmit
```

Expected: pass (Profile from config.ts is a superset of the local one).

**Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "refactor: use canonical Profile type in Sidebar instead of local redeclaration"
```

---

### Task 3: Extract `handleOpenActionPicker` into shared hook

**Evidence:**
- `src/components/AssignmentsWorkspace.tsx:55-76` — identical function
- `src/components/ProfilesWorkspace.tsx:600-615` — identical function
- Both depend on: `effectiveProfileId`, `selectedLayer`, `updateDraft`, `setActionPickerBindingId`, `setActionPickerOpen`
- Both call: `ensurePlaceholderBinding`, `makeBindingId` from config-editing

**Files:**
- Create: `src/hooks/useActionPicker.ts`
- Modify: `src/components/AssignmentsWorkspace.tsx` — use hook
- Modify: `src/components/ProfilesWorkspace.tsx` — use hook

**Step 1: Create `src/hooks/useActionPicker.ts`**

```typescript
import { useCallback } from "react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import {
  ensurePlaceholderBinding,
  makeBindingId,
} from "../lib/config-editing";

export function useActionPicker(deps: {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
}) {
  const {
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  } = deps;

  const handleOpenActionPicker = useCallback(
    (controlId: ControlId, binding: Binding | null) => {
      if (!effectiveProfileId) return;

      if (binding) {
        setActionPickerBindingId(binding.id);
        setActionPickerOpen(true);
        return;
      }

      updateDraft((config) => {
        const control = config.physicalControls.find((c) => c.id === controlId);
        if (!control) return config;
        return ensurePlaceholderBinding(config, effectiveProfileId, selectedLayer, control);
      });

      const bindingId = makeBindingId(effectiveProfileId, selectedLayer, controlId);
      setActionPickerBindingId(bindingId);
      setActionPickerOpen(true);
    },
    [effectiveProfileId, selectedLayer, updateDraft, setActionPickerBindingId, setActionPickerOpen],
  );

  return handleOpenActionPicker;
}
```

**Step 2: Update AssignmentsWorkspace.tsx**

- Remove imports of `ensurePlaceholderBinding`, `makeBindingId` (no longer needed directly)
- Remove `handleOpenActionPicker` function body (lines 55-76)
- Add: `import { useActionPicker } from "../hooks/useActionPicker";`
- Call hook: `const handleOpenActionPicker = useActionPicker({ effectiveProfileId, selectedLayer, updateDraft, setActionPickerBindingId, setActionPickerOpen });`

**Step 3: Update ProfilesWorkspace.tsx**

- Remove local `handleOpenActionPicker` function (lines 600-615)
- `ensurePlaceholderBinding` and `makeBindingId` are still needed for other uses in this file — verify before removing imports
- Add: `import { useActionPicker } from "../hooks/useActionPicker";`
- Call hook inside the component

**Step 4: Run tests and type-check**

```bash
npx vitest run && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/hooks/useActionPicker.ts src/components/AssignmentsWorkspace.tsx src/components/ProfilesWorkspace.tsx
git commit -m "refactor: extract shared handleOpenActionPicker into useActionPicker hook"
```

---

### Task 4: Add `runtimeCommand` wrapper to useRuntime

**Evidence:**
- `src/hooks/useRuntime.ts` has 9 catch blocks (lines 199, 214, 228, 242, 252, 266, 284, 303, 322)
- 7 of 8 async handlers follow identical pattern: try { API call → startTransition(setState) → refreshDebugLog } catch { startTransition(setError) }
- Exception: `handleRehookCapture` (no state update, no refreshDebugLog) — keep inline

**Files:**
- Modify: `src/hooks/useRuntime.ts`

**Step 1: Add helper function inside useRuntime body (after `refreshDebugLog`)**

```typescript
async function runtimeCommand<T>(
  command: () => Promise<T>,
  onSuccess: (result: T) => void,
) {
  try {
    const result = await command();
    startTransition(() => onSuccess(result));
    await refreshDebugLog();
  } catch (unknownError) {
    startTransition(() => {
      setError(normalizeCommandError(unknownError));
    });
  }
}
```

**Step 2: Rewrite 7 handlers using `runtimeCommand`**

```typescript
async function handleStartRuntime() {
  await runtimeCommand(() => startRuntime(), (summary) => setRuntimeSummary(summary));
}

async function handleReloadRuntime() {
  await runtimeCommand(() => reloadRuntime(), (summary) => setRuntimeSummary(summary));
}

async function handleStopRuntime() {
  await runtimeCommand(() => stopRuntime(), (summary) => setRuntimeSummary(summary));
}

// handleRehookCapture stays as-is (no state update, no refreshDebugLog)

async function handleCaptureActiveWindow() {
  await runtimeCommand(() => captureActiveWindow(captureDelayMs), (result) => setLastCapture(result));
}

async function handlePreviewResolution() {
  await runtimeCommand(
    () => previewResolution(
      resolutionKeyInput,
      lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
      lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
    ),
    (result) => setLastResolutionPreview(result),
  );
}

async function handleExecutePreviewAction() {
  await runtimeCommand(
    () => executePreviewAction(
      resolutionKeyInput,
      lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
      lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
    ),
    (result) => { setLastExecution(result); setLastRuntimeError(null); },
  );
}

async function handleRunPreviewAction() {
  await runtimeCommand(
    () => runPreviewAction(
      resolutionKeyInput,
      lastCapture && !lastCapture.ignored ? lastCapture.exe : undefined,
      lastCapture && !lastCapture.ignored ? lastCapture.title : undefined,
    ),
    (result) => { setLastExecution(result); setLastRuntimeError(null); },
  );
}
```

**Step 3: Run type-check**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/hooks/useRuntime.ts
git commit -m "refactor: extract runtimeCommand wrapper to DRY up error handling in useRuntime"
```

---

### Task 5: Split helpers.ts into domain modules

**Evidence:** `src/lib/helpers.ts` is 735 lines with 42 exports spanning 5 unrelated domains.

**Usage map (verified via grep):**

| New module | Exports | Consumers |
|---|---|---|
| `lib/labels.ts` | 18 display formatters: `labelFor*`, `badgeClassFor*`, `stateLabel`, `formatTimestamp`, `displayNameForControl`, `surfacePrimaryLabel`, `logLevelBadgeClass`, `actionCategoryIcon` + `CONTROL_DISPLAY_NAMES` const | Sidebar, DebugWorkspace, RuntimePanel, ServiceToolsPanel, ControlPropertiesPanel, MouseVisualization, MouseVisualizationSvg, ActionPickerModal, ActionInspector |
| `lib/action-helpers.ts` | 10 functions: `with*Payload` (5), `describeActionSummary`, `isActionLiveRunnable`, `createDefaultSequenceStep`, `coerceSequenceStepType`, `setSequenceStepDelay` | ActionInspector, ActionPickerModal, ControlPropertiesPanel, DebugWorkspace, ServiceToolsPanel |
| `lib/menu-helpers.ts` | 4 functions: `collectMenuItemIds`, `appendMenuItem`, `updateMenuItem`, `removeMenuItem` | ActionInspector only |
| `lib/verification-helpers.ts` | 5 exports: `describeVerificationAlignment`, `describeVerificationSessionSuggestion`, `verificationResultColor`, `controlPhysicalHint`, `dotLabel` | ControlPropertiesPanel, DebugWorkspace |
| `lib/helpers.ts` (trimmed) | 7 general utils: `controlName`, `resolveInitialProfileId`, `resolveInitialControlId`, `sortAppMappings`, `parseCommaSeparatedUniqueValues`, `parseCommaSeparatedList`, `parseOptionalNumber` | App.tsx, ProfilesWorkspace, ActionInspector, SnippetLibraryEditor, DebugWorkspace, ServiceToolsPanel |

**Files:**
- Create: `src/lib/labels.ts`
- Create: `src/lib/action-helpers.ts`
- Create: `src/lib/menu-helpers.ts`
- Create: `src/lib/verification-helpers.ts`
- Modify: `src/lib/helpers.ts` — remove extracted functions
- Modify: `src/lib/helpers.test.ts` — update imports
- Modify: 11 consumer files — update imports

**Step 1: Create `src/lib/labels.ts`**

Move these functions/consts from helpers.ts:
- `formatTimestamp` (line 493)
- `logLevelBadgeClass` (line 501)
- `labelForControlFamily` (line 510)
- `labelForEncoderSource` (line 523)
- `labelForRuntimeStatus` (line 536)
- `labelForPreviewStatus` (line 540)
- `labelForExecutionOutcome` (line 553)
- `labelForExecutionMode` (line 568)
- `labelForPasteMode` (line 572)
- `labelForSequenceStep` (line 576)
- `badgeClassForCapability` (line 589)
- `labelForCapability` (line 598)
- `labelForLayer` (line 611)
- `labelForVerificationResult` (line 615)
- `actionCategoryIcon` (line 657)
- `displayNameForControl` (line 705) + `CONTROL_DISPLAY_NAMES` (line 691)
- `stateLabel` (line 709)
- `surfacePrimaryLabel` (line 724)

Imports needed:
```typescript
import type { ActionType, Binding, Action, ControlId, EncoderMapping, Layer, PasteMode, PhysicalControl, SequenceStep } from "./config";
import type { ActionExecutionEvent, DebugLogEntry, ResolvedInputPreview, RuntimeStateSummary } from "./runtime";
import type { VerificationStepResult } from "./verification-session";
import type { ViewState } from "./constants";
import { ACTION_CATEGORIES, MEDIA_KEY_OPTIONS, MOUSE_ACTION_OPTIONS } from "./constants";
```

**Step 2: Create `src/lib/action-helpers.ts`**

Move these functions:
- `describeActionSummary` (line 102)
- `isActionLiveRunnable` (line 248)
- `withShortcutPayload` (line 285)
- `withTextSnippetPayload` (line 299)
- `withSequencePayload` (line 313)
- `withLaunchPayload` (line 327)
- `withMenuPayload` (line 341)
- `createDefaultSequenceStep` (line 355)
- `coerceSequenceStepType` (line 368)
- `setSequenceStepDelay` (line 405)

Imports needed:
```typescript
import type { Action, AppConfig, LaunchActionPayload, MenuActionPayload, PasteMode, SequenceActionPayload, SequenceStep, ShortcutActionPayload, SnippetLibraryItem, TextSnippetPayload } from "./config";
import { labelForPasteMode } from "./labels";
import { MEDIA_KEY_OPTIONS, MOUSE_ACTION_OPTIONS } from "./constants";
```

Note: `describeActionSummary` calls `labelForPasteMode` — cross-module dependency from action-helpers → labels. This is fine (labels is a leaf module).

**Step 3: Create `src/lib/menu-helpers.ts`**

Move these functions:
- `collectMenuItemIds` (line 422)
- `appendMenuItem` (line 430)
- `updateMenuItem` (line 458)
- `removeMenuItem` (line 479)

Imports needed:
```typescript
import type { MenuItem } from "./config";
```

**Step 4: Create `src/lib/verification-helpers.ts`**

Move these functions/consts:
- `describeVerificationAlignment` (line 162)
- `describeVerificationSessionSuggestion` (line 230)
- `verificationResultColor` (line 676)
- `controlPhysicalHint` (line 630)
- `dotLabel` (line 661)

Imports needed:
```typescript
import type { ControlId } from "./config";
import type { VerificationSession, VerificationStepResult } from "./verification-session";
```

**Step 5: Trim `src/lib/helpers.ts`**

Keep only:
- `controlName` (line 40)
- `resolveInitialProfileId` (line 44)
- `resolveInitialControlId` (line 52)
- `sortAppMappings` (line 61)
- `parseCommaSeparatedUniqueValues` (line 68)
- `parseCommaSeparatedList` (line 84)
- `parseOptionalNumber` (line 92)

Remove all moved functions. Remove unused imports.

**Step 6: Update all consumer imports**

Files to update and their new import sources:

| File | Remove from `helpers` | Add import from |
|---|---|---|
| `App.tsx` | `resolveInitialProfileId`, `resolveInitialControlId` | stays in helpers — no change needed |
| `Sidebar.tsx` | `stateLabel` | `../lib/labels` |
| `DebugWorkspace.tsx` | `controlName`, `controlPhysicalHint`, `describeVerificationSessionSuggestion`, `dotLabel`, `formatTimestamp`, `isActionLiveRunnable`, `labelForExecutionMode`, `labelForExecutionOutcome`, `labelForPreviewStatus`, `labelForVerificationResult`, `logLevelBadgeClass`, `verificationResultColor` | `controlName` stays in helpers; labels from `../lib/labels`; verification from `../lib/verification-helpers`; `isActionLiveRunnable` from `../lib/action-helpers` |
| `ControlPropertiesPanel.tsx` | `describeActionSummary`, `describeVerificationAlignment`, `formatTimestamp`, `labelForCapability`, `labelForControlFamily` | `describeActionSummary` from `../lib/action-helpers`; rest from `../lib/labels` and `../lib/verification-helpers` |
| `ActionInspector.tsx` | many | `action-helpers`, `menu-helpers`, `labels`, keep `parse*` from helpers |
| `ActionPickerModal.tsx` | `coerceSequenceStepType`, `createDefaultSequenceStep`, `labelForSequenceStep`, `setSequenceStepDelay` | `action-helpers` and `labels` |
| `RuntimePanel.tsx` | `formatTimestamp`, `labelForRuntimeStatus` | `../lib/labels` |
| `ServiceToolsPanel.tsx` | many | `action-helpers`, `labels`, keep `controlName` from helpers |
| `MouseVisualization.tsx` | `displayNameForControl`, `surfacePrimaryLabel` | `../lib/labels` |
| `MouseVisualizationSvg.tsx` | `displayNameForControl`, `surfacePrimaryLabel` | `../lib/labels` |
| `ProfilesWorkspace.tsx` | `parseCommaSeparatedUniqueValues`, `sortAppMappings` | stays in helpers — no change needed |
| `SnippetLibraryEditor.tsx` | `parseCommaSeparatedUniqueValues` | stays in helpers — no change needed |

**Step 7: Update `src/lib/helpers.test.ts`**

Update imports to pull from new modules. The test file imports almost everything — split imports across `labels`, `action-helpers`, `menu-helpers`, `verification-helpers`, and `helpers`.

**Step 8: Run all tests and type-check**

```bash
npx vitest run && npx tsc --noEmit
```

**Step 9: Commit**

```bash
git add src/lib/labels.ts src/lib/action-helpers.ts src/lib/menu-helpers.ts src/lib/verification-helpers.ts src/lib/helpers.ts src/lib/helpers.test.ts src/components/*.tsx src/App.tsx
git commit -m "refactor: split helpers.ts (735 lines) into 4 domain modules + trimmed helpers"
```

---

### Task 6: Group DebugWorkspace props into domain objects

**Evidence:**
- `src/components/DebugWorkspace.tsx:47-85` — interface with 30+ fields
- `src/App.tsx:426-463` — passing each field individually

**Files:**
- Modify: `src/components/DebugWorkspace.tsx` — restructure props interface
- Modify: `src/App.tsx` — pass grouped objects

**Step 1: Group DebugWorkspaceProps into sub-objects**

```typescript
export interface DebugWorkspaceProps {
  activeConfig: AppConfig;
  profiles: Profile[];
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  snippetById: Map<string, SnippetLibraryItem>;
  selectedLayer: Layer;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  // Grouped: runtime
  runtime: {
    debugLog: DebugLogEntry[];
    resolutionKeyInput: string;
    setResolutionKeyInput: (value: string) => void;
    lastResolutionPreview: ResolvedInputPreview | null;
    lastExecution: ActionExecutionEvent | null;
    lastRuntimeError: RuntimeErrorEvent | null;
    lastEncodedKey: EncodedKeyEvent | null;
    runtimeSummary: RuntimeStateSummary;
    handlePreviewResolution: () => Promise<void>;
    handleExecutePreviewAction: () => Promise<void>;
    handleRunPreviewAction: () => Promise<void>;
  };
  // Grouped: verification
  verification: {
    session: VerificationSession | null;
    scope: VerificationSessionScope;
    setScope: (scope: VerificationSessionScope) => void;
    lastExportPath: string | null;
    sessionSummary: VerificationSessionSummary;
    currentStep: VerificationSessionStep | null;
    suggestedResult: Exclude<VerificationStepResult, "pending"> | null;
    hasResults: boolean;
    handleStart: () => Promise<void>;
    handleRestartStep: () => void;
    handleResult: (result: Exclude<VerificationStepResult, "pending">) => void;
    handleNotesChange: (notes: string) => void;
    handleNavigateStep: (index: number) => void;
    handleReopenStep: (index: number) => void;
    handleReset: () => void;
    handleExport: () => Promise<void>;
  };
}
```

**Step 2: Update DebugWorkspace body to destructure from groups**

Replace `props.lastResolutionPreview` with `props.runtime.lastResolutionPreview`, etc.
Or destructure: `const { debugLog, resolutionKeyInput, ... } = props.runtime;`

**Step 3: Update App.tsx to pass grouped props**

```tsx
<DebugWorkspace
  activeConfig={activeConfig}
  profiles={profiles}
  selectedControl={selectedControl}
  selectedBinding={selectedBinding}
  selectedAction={selectedAction}
  selectedEncoder={selectedEncoder}
  snippetById={snippetById}
  selectedLayer={selectedLayer}
  updateDraft={updateDraft}
  runtime={{
    debugLog,
    resolutionKeyInput,
    setResolutionKeyInput,
    lastResolutionPreview,
    lastExecution,
    lastRuntimeError,
    lastEncodedKey,
    runtimeSummary,
    handlePreviewResolution,
    handleExecutePreviewAction,
    handleRunPreviewAction,
  }}
  verification={{
    session: verificationSession,
    scope: verificationScope,
    setScope: setVerificationScope,
    // ... etc
  }}
/>
```

**Step 4: Run type-check**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/components/DebugWorkspace.tsx src/App.tsx
git commit -m "refactor: group DebugWorkspace props into runtime/verification sub-objects"
```

---

## Summary

| Task | What | Lines saved | Risk |
|---|---|---|---|
| 1 | Delete duplicate `collectMenuActionRefs` | ~12 | Zero |
| 2 | Fix Sidebar Profile import | ~4 | Zero |
| 3 | Extract `useActionPicker` hook | ~30 | Low |
| 4 | Add `runtimeCommand` wrapper | ~50 | Low |
| 5 | Split helpers.ts into 4 modules | 0 (restructure) | Low |
| 6 | Group DebugWorkspace props | 0 (restructure) | Medium |

Total estimated time: ~2 hours
