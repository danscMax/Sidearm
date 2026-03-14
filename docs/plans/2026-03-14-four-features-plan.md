# Four Features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add right-click context menu on hotspots, profile import/export, usage heatmap, and drag-and-drop action assignment.

**Architecture:** Context menu reuses existing `ContextMenu` component, wired to hotspot `onContextMenu`. Profile export extracts a profile subtree to JSON via dialog+IPC. Heatmap accumulates `action_executed` events in React state and overlays color intensity on hotspots. Drag-and-drop uses native HTML5 DataTransfer API.

**Tech Stack:** React 19, TypeScript 5.8, Tauri v2, Rust, Vitest 4

**Verification:** `npx vitest run && npx tsc --noEmit` (frontend), `cargo check` (Rust, from src-tauri/)

---

## Phase 1: Right-click context menu on hotspots

### Task 1: Add context menu state and props

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/components/MouseVisualizationSvg.tsx`
- Modify: `src/App.tsx`

**Step 1:** Extend `MouseVisualizationProps` in both components — add:

```typescript
onContextMenu: (id: ControlId, binding: Binding | null, action: Action | null, x: number, y: number) => void;
```

**Step 2:** Add `onContextMenu` handler in both components:

```typescript
function handleContextMenu(id: ControlId, e: React.MouseEvent) {
  e.preventDefault();
  const entry = entryMap.get(id);
  onContextMenu(id, entry?.binding ?? null, entry?.action ?? null, e.clientX, e.clientY);
}
```

Wire it to hotspot elements: `onContextMenu={(e) => handleContextMenu(controlId, e)}` on the same elements that have `onClick` and `onDoubleClick`.

**Step 3:** In `App.tsx`, add state for context menu:

```typescript
const [hotspotCtxMenu, setHotspotCtxMenu] = useState<{
  x: number;
  y: number;
  controlId: ControlId;
  binding: Binding | null;
  action: Action | null;
} | null>(null);

const [bindingClipboard, setBindingClipboard] = useState<{
  binding: Binding;
  action: Action;
} | null>(null);
```

Pass `onContextMenu` callback to both visualization components that sets `hotspotCtxMenu`.

**Step 4:** Verify: `npx tsc --noEmit`

---

### Task 2: Add removeBinding helper to config-editing

**Files:**
- Modify: `src/lib/config-editing.ts`
- Modify: `src/lib/config-editing.test.ts`

**Step 1:** Write test in `config-editing.test.ts`:

```typescript
describe("removeBinding", () => {
  it("removes a binding and its orphaned action", () => {
    const config = makeConfig({
      bindings: [{ id: "b1", actionRef: "a1", profileId: "p1", layer: "standard", controlId: "thumb_1" }],
      actions: [{ id: "a1", type: "disabled", payload: { reason: "" }, pretty: "test" }],
    });
    const result = removeBinding(config, "b1");
    expect(result.bindings).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
  });

  it("keeps action if referenced by another binding", () => {
    const config = makeConfig({
      bindings: [
        { id: "b1", actionRef: "a1", profileId: "p1", layer: "standard", controlId: "thumb_1" },
        { id: "b2", actionRef: "a1", profileId: "p1", layer: "hypershift", controlId: "thumb_1" },
      ],
      actions: [{ id: "a1", type: "disabled", payload: { reason: "" }, pretty: "test" }],
    });
    const result = removeBinding(config, "b1");
    expect(result.bindings).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
  });
});
```

**Step 2:** Implement `removeBinding` in `config-editing.ts`:

```typescript
export function removeBinding(config: AppConfig, bindingId: string): AppConfig {
  const binding = config.bindings.find((b) => b.id === bindingId);
  if (!binding) return config;

  const nextBindings = config.bindings.filter((b) => b.id !== bindingId);
  const actionStillReferenced = nextBindings.some((b) => b.actionRef === binding.actionRef);
  const nextActions = actionStillReferenced
    ? config.actions
    : config.actions.filter((a) => a.id !== binding.actionRef);

  return { ...config, bindings: nextBindings, actions: nextActions };
}
```

**Step 3:** Run: `npx vitest run src/lib/config-editing.test.ts`

**Step 4:** Commit: `"feat: add removeBinding helper with orphan action cleanup"`

---

### Task 3: Render the context menu

**Files:**
- Modify: `src/App.tsx`

**Step 1:** Import `ContextMenu` and render it when `hotspotCtxMenu` is set:

```tsx
{hotspotCtxMenu ? (
  <ContextMenu
    x={hotspotCtxMenu.x}
    y={hotspotCtxMenu.y}
    onClose={() => setHotspotCtxMenu(null)}
    items={buildHotspotMenuItems(hotspotCtxMenu, bindingClipboard, /* deps */)}
  />
) : null}
```

**Step 2:** Implement `buildHotspotMenuItems` as a local function:

For a button WITH binding:
1. "Редактировать" → open ActionPickerModal
2. "Копировать привязку" → `setBindingClipboard({ binding, action })`
3. "Копировать на {otherLayerLabel}" → `updateDraft(c => upsertBinding(c, { ...binding, id: newId, layer: otherLayer }))` — also clone the action with new ID
4. `null` (separator)
5. "Отключить" / "Включить" → `updateDraft(c => upsertBinding(c, { ...binding, enabled: !binding.enabled }))`
6. "Очистить" (danger) → `updateDraft(c => removeBinding(c, binding.id))`

For a button WITHOUT binding:
1. "Назначить действие" → open ActionPickerModal
2. "Вставить привязку" (disabled if clipboard empty) → create new binding+action from clipboard for this controlId

Close menu after each action.

**Step 3:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 4:** Commit: `"feat: right-click context menu on mouse button hotspots"`

---

## Phase 2: Profile import/export

### Task 4: Profile export — extract subtree + save to file

**Files:**
- Modify: `src/lib/config-editing.ts`
- Modify: `src/lib/config-editing.test.ts`
- Modify: `src/components/ProfilesWorkspace.tsx` (export button in UI)

**Step 1:** Write test for `extractProfileExport`:

```typescript
describe("extractProfileExport", () => {
  it("extracts profile with its bindings, actions, and appMappings", () => {
    const config = makeConfigWithProfile("p1", { bindings: 3, appMappings: 1 });
    const exported = extractProfileExport(config, "p1");
    expect(exported.profile.id).toBe("p1");
    expect(exported.bindings.length).toBe(3);
    expect(exported.appMappings.length).toBe(1);
    expect(exported.actions.length).toBeGreaterThan(0);
  });
});
```

**Step 2:** Implement `extractProfileExport`:

```typescript
export interface ProfileExportData {
  version: number;
  exportedAt: string;
  profile: Profile;
  bindings: Binding[];
  actions: Action[];
  appMappings: AppMapping[];
}

export function extractProfileExport(config: AppConfig, profileId: string): ProfileExportData {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const bindings = config.bindings.filter((b) => b.profileId === profileId);
  const actionIds = new Set(bindings.map((b) => b.actionRef));
  const actions = config.actions.filter((a) => actionIds.has(a.id));
  const appMappings = config.appMappings.filter((m) => m.profileId === profileId);

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    profile,
    bindings,
    actions,
    appMappings,
  };
}
```

**Step 3:** Add export button in ProfilesWorkspace toolbar. On click:

```typescript
async function handleExportProfile() {
  if (!activeProfile || !activeConfig) return;
  const data = extractProfileExport(activeConfig, activeProfile.id);
  const json = JSON.stringify(data, null, 2);
  const path = await save({
    title: "Экспорт профиля",
    defaultPath: `${activeProfile.name}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (path) {
    await writeTextFile(path, json);
  }
}
```

**Step 4:** Verify: `npx vitest run && npx tsc --noEmit`

**Step 5:** Commit: `"feat: profile export to JSON file"`

---

### Task 5: Profile import — parse, validate, merge

**Files:**
- Modify: `src/lib/config-editing.ts`
- Modify: `src/lib/config-editing.test.ts`
- Modify: `src/components/ProfilesWorkspace.tsx` (import button in UI)

**Step 1:** Write test for `mergeImportedProfile`:

```typescript
describe("mergeImportedProfile", () => {
  it("merges imported profile into existing config", () => {
    const existing = makeConfig({ profiles: [{ id: "p1", name: "Default" }] });
    const imported: ProfileExportData = {
      version: 2,
      exportedAt: "",
      profile: { id: "p2", name: "Gaming", enabled: true, priority: 0 },
      bindings: [],
      actions: [],
      appMappings: [],
    };
    const result = mergeImportedProfile(existing, imported);
    expect(result.profiles).toHaveLength(2);
  });

  it("generates new IDs on collision", () => {
    const existing = makeConfig({
      profiles: [{ id: "p1", name: "Default" }],
      bindings: [{ id: "b1", profileId: "p1", actionRef: "a1" }],
    });
    const imported: ProfileExportData = {
      version: 2,
      exportedAt: "",
      profile: { id: "p1", name: "Imported", enabled: true, priority: 0 },
      bindings: [{ id: "b1", profileId: "p1", actionRef: "a1" }],
      actions: [{ id: "a1", type: "disabled", payload: { reason: "" }, pretty: "" }],
      appMappings: [],
    };
    const result = mergeImportedProfile(existing, imported);
    expect(result.profiles).toHaveLength(2);
    const importedProfile = result.profiles.find((p) => p.name === "Imported");
    expect(importedProfile).toBeDefined();
    expect(importedProfile!.id).not.toBe("p1");
  });
});
```

**Step 2:** Implement `mergeImportedProfile`:

```typescript
export function mergeImportedProfile(config: AppConfig, data: ProfileExportData): AppConfig {
  const existingIds = new Set([
    ...config.profiles.map((p) => p.id),
    ...config.bindings.map((b) => b.id),
    ...config.actions.map((a) => a.id),
    ...config.appMappings.map((m) => m.id),
  ]);

  function freshId(original: string): string {
    if (!existingIds.has(original)) return original;
    let id: string;
    do { id = crypto.randomUUID(); } while (existingIds.has(id));
    existingIds.add(id);
    return id;
  }

  const profileId = freshId(data.profile.id);
  const actionIdMap = new Map<string, string>();
  const bindingIdMap = new Map<string, string>();

  const actions = data.actions.map((a) => {
    const newId = freshId(a.id);
    actionIdMap.set(a.id, newId);
    return { ...a, id: newId };
  });

  const bindings = data.bindings.map((b) => {
    const newId = freshId(b.id);
    bindingIdMap.set(b.id, newId);
    return {
      ...b,
      id: newId,
      profileId,
      actionRef: actionIdMap.get(b.actionRef) ?? b.actionRef,
    };
  });

  const appMappings = data.appMappings.map((m) => ({
    ...m,
    id: freshId(m.id),
    profileId,
  }));

  return {
    ...config,
    profiles: [...config.profiles, { ...data.profile, id: profileId }],
    bindings: [...config.bindings, ...bindings],
    actions: [...config.actions, ...actions],
    appMappings: [...config.appMappings, ...appMappings],
  };
}
```

**Step 3:** Add import button in ProfilesWorkspace. On click:

```typescript
async function handleImportProfile() {
  const path = await open({
    title: "Импорт профиля",
    filters: [{ name: "JSON", extensions: ["json"] }],
    multiple: false,
  });
  if (typeof path !== "string") return;
  const json = await readTextFile(path);
  const data = JSON.parse(json) as ProfileExportData;
  if (data.version !== 2 || !data.profile) {
    // show error
    return;
  }
  updateDraft((c) => mergeImportedProfile(c, data));
}
```

**Step 4:** Verify: `npx vitest run && npx tsc --noEmit`

**Step 5:** Commit: `"feat: profile import from JSON file with ID collision handling"`

---

## Phase 3: Usage heatmap

### Task 6: Accumulate execution counts in useRuntime

**Files:**
- Modify: `src/hooks/useRuntime.ts`

**Step 1:** Add state for execution counts:

```typescript
const [executionCounts, setExecutionCounts] = useState<Map<string, number>>(new Map());
```

**Step 2:** In `handleActionExecutionEvent`, increment count:

```typescript
const handleActionExecutionEvent = useEffectEvent((event: ActionExecutionEvent) => {
  startTransition(() => {
    setLastExecution(event);
    setLastRuntimeError(null);
    if (event.mode === "live" && event.control_id) {
      setExecutionCounts((prev) => {
        const next = new Map(prev);
        const key = event.control_id;
        next.set(key, (next.get(key) ?? 0) + 1);
        return next;
      });
    }
  });
  void refreshDebugLog();
});
```

**Step 3:** Add `clearExecutionCounts` function and expose both in return object:

```typescript
function clearExecutionCounts() {
  startTransition(() => setExecutionCounts(new Map()));
}
```

Add `executionCounts` and `clearExecutionCounts` to RuntimeControl interface and return.

**Step 4:** Verify: `npx tsc --noEmit`

**Step 5:** Commit: `"feat: track per-button execution counts in useRuntime"`

---

### Task 7: Heatmap visualization on hotspots

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/components/MouseVisualizationSvg.tsx`
- Modify: `src/App.css`

**Step 1:** Add `executionCounts` and `heatmapEnabled` to `MouseVisualizationProps`:

```typescript
executionCounts?: Map<string, number>;
heatmapEnabled?: boolean;
```

**Step 2:** In both components, compute normalized heat value per hotspot:

```typescript
const maxCount = Math.max(1, ...Array.from(executionCounts?.values() ?? []));
function heatColor(controlId: ControlId): string | undefined {
  if (!heatmapEnabled || !executionCounts) return undefined;
  const count = executionCounts.get(controlId) ?? 0;
  if (count === 0) return undefined;
  const intensity = Math.min(count / maxCount, 1);
  return `rgba(159, 202, 105, ${0.15 + intensity * 0.55})`;
}
```

Apply as inline `backgroundColor` (photo mode) or `fill` (SVG mode) on hotspot elements.

**Step 3:** Add CSS for heatmap badge (optional count overlay):

```css
.hotspot__heat-count {
  position: absolute;
  bottom: -4px;
  right: -4px;
  font-size: var(--fs-micro);
  background: var(--c-accent);
  color: var(--c-bg);
  border-radius: var(--radius-pill);
  padding: 0 4px;
  font-weight: 700;
  pointer-events: none;
}
```

**Step 4:** Add heatmap toggle button in toolbar (where workspace controls are).

**Step 5:** Wire `executionCounts` and `heatmapEnabled` from App.tsx down to visualization components.

**Step 6:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 7:** Commit: `"feat: heatmap overlay on mouse button hotspots"`

---

## Phase 4: Drag-and-drop action assignment

### Task 8: Make hotspots draggable and droppable

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/components/MouseVisualizationSvg.tsx`
- Modify: `src/App.css`

**Step 1:** Add drag handlers to hotspot buttons (both components):

```typescript
function handleDragStart(id: ControlId, e: React.DragEvent) {
  const entry = entryMap.get(id);
  if (!entry?.binding || !entry?.action) {
    e.preventDefault();
    return;
  }
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData("application/json", JSON.stringify({
    type: "binding",
    bindingId: entry.binding.id,
    actionId: entry.action.id,
  }));
}
```

**Step 2:** Add drop handlers:

```typescript
function handleDragOver(e: React.DragEvent) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

function handleDrop(targetControlId: ControlId, e: React.DragEvent) {
  e.preventDefault();
  const raw = e.dataTransfer.getData("application/json");
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data.type === "binding") {
      onDropBinding?.(targetControlId, data.actionId);
    }
  } catch {}
}
```

**Step 3:** Add `onDropBinding` to props:

```typescript
onDropBinding?: (targetControlId: ControlId, actionId: string) => void;
```

**Step 4:** In App.tsx, implement `onDropBinding` — creates/updates binding for the target controlId with a clone of the source action:

```typescript
function handleDropBinding(targetControlId: ControlId, actionId: string) {
  if (!activeConfig || !effectiveProfileId) return;
  updateDraft((config) => {
    const sourceAction = config.actions.find((a) => a.id === actionId);
    if (!sourceAction) return config;
    const newAction = { ...sourceAction, id: crypto.randomUUID() };
    const bindingId = makeBindingId(effectiveProfileId, selectedLayer, targetControlId);
    const newBinding: Binding = {
      id: bindingId,
      profileId: effectiveProfileId,
      layer: selectedLayer,
      controlId: targetControlId,
      label: newAction.pretty,
      actionRef: newAction.id,
      enabled: true,
    };
    return {
      ...upsertBinding({ ...config, actions: [...config.actions, newAction] }, newBinding),
    };
  });
}
```

**Step 5:** Add CSS for drag feedback:

```css
.hotspot--dragover {
  outline: 2px dashed var(--c-accent);
  outline-offset: 2px;
}
```

Manage `dragover` class via state or direct ref manipulation on `dragenter`/`dragleave`.

**Step 6:** Wire `onDropBinding`, mark hotspot elements with `draggable={!!entry?.binding}`, add drag/drop event handlers.

**Step 7:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 8:** Commit: `"feat: drag-and-drop binding assignment between hotspots"`

---

## Execution Order Summary

| Phase | Tasks | Gate |
|-------|-------|------|
| 1. Context menu | Tasks 1-3 | `tsc + vitest` |
| 2. Profile export/import | Tasks 4-5 | `tsc + vitest` |
| 3. Heatmap | Tasks 6-7 | `tsc + vitest` |
| 4. Drag-and-drop | Task 8 | `tsc + vitest` |

Each phase MUST pass all tests before proceeding to the next.
