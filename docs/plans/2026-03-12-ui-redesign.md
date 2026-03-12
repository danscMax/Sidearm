# UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the Assignments and Profiles workspaces to match Razer Synapse UX patterns — callout lines, single-column layout, Russian names, file picker, and bug fixes.

**Architecture:** The core change is replacing the 2-column assignments layout with a full-width Synapse-style mouse visualization that shows callout lines (SVG) from each button to its action label. The right panel is removed. Layer switcher moves from the sidebar to below the mouse. ProfilesWorkspace gets a file picker dialog and UX cleanup. ActionPickerModal bug fix for stale label names.

**Tech Stack:** React 19 (React Compiler), TypeScript, Tauri v2 `dialog` plugin, SVG for callout lines, CSS Grid

---

## Phase 1: Bug Fixes (Quick Wins)

### Task 1: Fix ActionPickerModal stale label when switching categories

The `nameDraft` state is initialized from `existingAction?.pretty` when the modal opens and never resets when switching categories. If you open a button with "Ctrl+V", switch to Text, type something, the "Название" field still shows "Ctrl+V".

**Files:**
- Modify: `src/components/ActionPickerModal.tsx:292-294, 242-245`

**Step 1: Reset nameDraft when category changes**

In `setActiveCategoryWithMemory` (line 242), clear `nameDraft` so it picks up `autoName()` for the new type:

```typescript
function setActiveCategoryWithMemory(cat: string) {
  setActiveCategory(cat);
  setNameDraft("");
  localStorage.setItem("naga-studio:lastPickerCategory", cat);
}
```

**Step 2: Verify in browser**

Run: `npx tauri dev`
- Open a button that has a shortcut assigned (e.g., "Ctrl+V")
- Switch to Text category
- Verify "Название" field is empty (placeholder shows auto-generated name)
- Type text, verify placeholder updates to text content
- Save, verify the button label on the mouse and in the sidebar updates correctly

**Step 3: Commit**

```bash
git add src/components/ActionPickerModal.tsx
git commit -m "fix: reset action name draft when switching picker category"
```

---

### Task 2: Russian button names + remove verification badge from assignments

Replace English "Thumb 1".."Thumb 12" with Russian "Кнопка 1".."Кнопка 12" in the display layer. Remove the capability badge from assignments view (it stays on the Verification tab).

**Files:**
- Modify: `src/lib/constants.ts:86-114` (hotspot labels)
- Modify: `src/lib/helpers.ts` (add `displayNameForControl` function)
- Modify: `src/components/AssignmentsWorkspace.tsx:88-99` (remove badge)

**Step 1: Add `displayNameForControl` to helpers.ts**

After the existing `labelForCapability` function, add:

```typescript
const CONTROL_DISPLAY_NAMES: Partial<Record<ControlId, string>> = {
  thumb_01: "Кнопка 1", thumb_02: "Кнопка 2", thumb_03: "Кнопка 3",
  thumb_04: "Кнопка 4", thumb_05: "Кнопка 5", thumb_06: "Кнопка 6",
  thumb_07: "Кнопка 7", thumb_08: "Кнопка 8", thumb_09: "Кнопка 9",
  thumb_10: "Кнопка 10", thumb_11: "Кнопка 11", thumb_12: "Кнопка 12",
  mouse_left: "ЛКМ", mouse_right: "ПКМ",
  mouse_4: "Кнопка мыши 4", mouse_5: "Кнопка мыши 5",
  wheel_up: "Прокрутка вверх", wheel_down: "Прокрутка вниз",
  wheel_click: "Клик колесом", wheel_left: "Колесо влево", wheel_right: "Колесо вправо",
  hypershift_button: "Razer Hypershift",
  top_aux_01: "DPI вверх", top_aux_02: "DPI вниз",
  top_special_01: "Доп. кнопка 1", top_special_02: "Доп. кнопка 2", top_special_03: "Доп. кнопка 3",
};

export function displayNameForControl(control: PhysicalControl): string {
  return CONTROL_DISPLAY_NAMES[control.id] ?? control.defaultName;
}
```

**Step 2: Remove verification badge from AssignmentsWorkspace control strip**

In `AssignmentsWorkspace.tsx`, replace lines 88-100 (the control strip with badge) with:

```tsx
<div className="control-strip">
  <span className="control-strip__name">{displayNameForControl(selectedControl)}</span>
  <span className="control-strip__action">
    {selectedBinding
      ? selectedAction?.pretty ?? selectedBinding.label
      : "Назначение не создано"}
  </span>
</div>
```

Remove the `badgeClassForCapability` and `labelForCapability` imports if no longer used in this file.

**Step 3: Update MouseVisualization to use displayNameForControl**

In `MouseVisualization.tsx`, replace `entry.control.defaultName` with `displayNameForControl(entry.control)` in the tooltip (line 51) and label (line 99). Import `displayNameForControl` from helpers.

**Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
git add src/lib/helpers.ts src/components/AssignmentsWorkspace.tsx src/components/MouseVisualization.tsx
git commit -m "feat: Russian button names, remove verification badge from assignments"
```

---

## Phase 2: Assignments Layout Redesign

### Task 3: Convert assignments to single-column layout with callout lines

This is the largest task. Replace the 2-column (mouse left, details right) layout with a single full-width view showing the mouse with SVG callout lines pointing to action labels — like Razer Synapse.

**Files:**
- Rewrite: `src/components/MouseVisualization.tsx` (add callout lines via SVG)
- Rewrite: `src/components/AssignmentsWorkspace.tsx` (remove right panel, single column)
- Modify: `src/App.tsx:390-391` (assignments now also 1-column)
- Modify: `src/App.css` (new styles for callouts)

**Step 1: Define callout anchor data**

In `src/lib/constants.ts`, add callout anchor positions for each hotspot. Each button needs a `calloutSide: "left" | "right"` to determine which side the label goes.

```typescript
export type CalloutAnchor = HotspotPosition & {
  calloutSide: "left" | "right";
};

export const topViewCallouts: Partial<Record<ControlId, CalloutAnchor>> = {
  mouse_left:        { left: 26, top: 10, label: "ЛКМ", calloutSide: "left" },
  top_aux_01:        { left: 10, top: 11, label: "DPI↑", size: "sm", calloutSide: "left" },
  top_aux_02:        { left: 10, top: 21, label: "DPI↓", size: "sm", calloutSide: "left" },
  mouse_4:           { left: 32, top: 22.5, label: "→", size: "sm", calloutSide: "left" },
  wheel_up:          { left: 45.5, top: 13.5, label: "▲", size: "sm", calloutSide: "right" },
  wheel_click:       { left: 45.5, top: 22.5, label: "●", size: "sm", calloutSide: "right" },
  wheel_down:        { left: 45.5, top: 31.5, label: "▼", size: "sm", calloutSide: "right" },
  hypershift_button: { left: 66, top: 10, label: "HS", size: "sm", calloutSide: "right" },
  mouse_5:           { left: 59.5, top: 23, label: "←", size: "sm", calloutSide: "right" },
};

export const sideViewCallouts: Partial<Record<ControlId, CalloutAnchor>> = {
  // Thumb buttons: left column (1,2,3) go left, right column (10,11,12) go right, middle split
  thumb_01: { left: 44.5, top: 76, label: "1", calloutSide: "left" },
  thumb_02: { left: 42.5, top: 56, label: "2", calloutSide: "left" },
  thumb_03: { left: 41, top: 36.5, label: "3", calloutSide: "left" },
  thumb_04: { left: 51.5, top: 73, label: "4", calloutSide: "left" },
  thumb_05: { left: 50, top: 53.5, label: "5", calloutSide: "left" },
  thumb_06: { left: 48.5, top: 33.5, label: "6", calloutSide: "left" },
  thumb_07: { left: 59, top: 71, label: "7", calloutSide: "right" },
  thumb_08: { left: 57, top: 51, label: "8", calloutSide: "right" },
  thumb_09: { left: 55.5, top: 31.5, label: "9", calloutSide: "right" },
  thumb_10: { left: 66, top: 68.5, label: "10", calloutSide: "right" },
  thumb_11: { left: 64, top: 49, label: "11", calloutSide: "right" },
  thumb_12: { left: 62.5, top: 29, label: "12", calloutSide: "right" },
};
```

**Step 2: Rewrite MouseVisualization with callout lines**

The new `MouseVisualization` component renders:
1. A container with CSS `position: relative`
2. An SVG overlay that draws lines from each hotspot to callout labels
3. Callout labels positioned on the left/right side with the action name
4. Hotspot buttons still clickable on the mouse image
5. Double-click on hotspot or click on callout label opens the ActionPicker

New props:
```typescript
interface MouseVisualizationProps {
  entries: ControlSurfaceEntry[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
  onOpenActionPicker: (id: ControlId) => void;  // NEW: double-click or label click
}
```

The component should render each view (top + side) in a container with:
- The mouse image
- An SVG overlay (`position: absolute; inset: 0; pointer-events: none`)
- SVG `<line>` elements from each hotspot position to the edge
- Callout text labels positioned outside the image using CSS absolute positioning
- Labels are `pointer-events: auto` so they're clickable

The SVG lines go from the hotspot % position to the left/right edge of the container. Labels are positioned at the end of each line.

For left-side callouts: line goes from hotspot to left edge, label is left-aligned
For right-side callouts: line goes from hotspot to right edge, label is right-aligned

Each callout label shows: `displayNameForControl(control)` or `action.pretty` if assigned.

If the button is selected, highlight the callout line and label with the accent color.

**Step 3: Rewrite AssignmentsWorkspace to single-column**

Remove the entire `workspace__right` div. The component now renders:

```tsx
export function AssignmentsWorkspace({
  entries, // flat entries list (was familySections.flatMap)
  selectedLayer,
  multiSelectedControlIds,
  onSelectControl,
  onToggleMultiSelect,
  onOpenActionPicker,
}: AssignmentsWorkspaceProps) {
  return (
    <div className="workspace__center">
      <MouseVisualization
        entries={entries}
        selectedLayer={selectedLayer}
        multiSelectedControlIds={multiSelectedControlIds}
        onSelectControl={onSelectControl}
        onToggleMultiSelect={onToggleMultiSelect}
        onOpenActionPicker={onOpenActionPicker}
      />
    </div>
  );
}
```

The right panel functionality (assign action, remove, copy to layer) is now accessed via:
- Double-click on hotspot → opens ActionPicker modal directly
- Click on callout label → opens ActionPicker modal
- Right-click context menu (future) or keyboard shortcuts

**Step 4: Update App.tsx**

Change `workspaceClass` so assignments mode also uses 1-column:

```typescript
const workspaceClass = "workspace workspace--1col";
```

Wire up the new `onOpenActionPicker` prop that creates a binding if needed and opens the modal:

```typescript
onOpenActionPicker={(controlId) => {
  const control = activeConfig?.physicalControls.find((c) => c.id === controlId);
  if (!control || !effectiveProfileId) return;
  updateDraft((config) => {
    const updated = ensurePlaceholderBinding(config, effectiveProfileId, selectedLayer, control);
    const binding = findBinding(updated, effectiveProfileId, selectedLayer, controlId);
    if (binding) {
      startTransition(() => {
        setActionPickerBindingId(binding.id);
        setActionPickerOpen(true);
      });
    }
    return updated;
  });
}}
```

**Step 5: Add CSS for callout lines**

In `App.css`, add styles for the new callout system:

```css
/* Callout container — wraps image + SVG + labels */
.mouse-callout-container {
  position: relative;
  display: grid;
  grid-template-columns: 180px 1fr 180px; /* labels | image | labels */
  align-items: stretch;
  gap: 0;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}

.mouse-callout-container__image {
  position: relative;
}

/* SVG overlay for lines */
.mouse-callout-container__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}

.callout-line {
  stroke: var(--c-border);
  stroke-width: 1;
  transition: stroke 150ms ease;
}

.callout-line--active {
  stroke: var(--c-accent);
  stroke-width: 1.5;
}

/* Label columns */
.mouse-callout-labels {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
}

.callout-label {
  font-size: var(--fs-small);
  color: var(--c-text-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 150ms ease, color 150ms ease;
}

.callout-label:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--c-text);
}

.callout-label--selected {
  color: var(--c-accent);
  font-weight: 600;
}

.callout-label--right {
  text-align: left;
}

.callout-label--left {
  text-align: right;
}
```

**Step 6: Type check and visual verify**

Run: `npx tsc --noEmit`
Then: `npx tauri dev` — verify the new layout looks correct with callout lines

**Step 7: Commit**

```bash
git add src/components/MouseVisualization.tsx src/components/AssignmentsWorkspace.tsx src/App.tsx src/App.css src/lib/constants.ts
git commit -m "feat: Synapse-style callout lines, single-column assignments layout"
```

---

### Task 4: Move layer switcher from sidebar to below mouse

Remove the layer toggle from the Sidebar. Add it below the MouseVisualization in AssignmentsWorkspace and VerificationWorkspace.

**Files:**
- Modify: `src/components/Sidebar.tsx:94-121` (remove layer section)
- Modify: `src/components/AssignmentsWorkspace.tsx` (add layer toggle below mouse)
- Modify: `src/components/VerificationWorkspace.tsx` (add layer toggle)
- Modify: `src/App.tsx:388,403-405` (remove showLayerRail prop)

**Step 1: Remove layer section from Sidebar**

Delete lines 94-121 in `Sidebar.tsx` (the entire `showLayerRail` conditional block). Remove `showLayerRail`, `selectedLayer`, `onSelectLayer`, `verificationSession` from props interface.

**Step 2: Add LayerToggle to AssignmentsWorkspace**

Below the `<MouseVisualization>`, add:

```tsx
<div className="layer-toggle layer-toggle--centered">
  {layerCopy.map((layer) => (
    <button
      key={layer.value}
      type="button"
      className={`layer-toggle__btn${selectedLayer === layer.value ? " layer-toggle__btn--active" : ""}`}
      onClick={() => onSelectLayer(layer.value)}
    >
      {layer.label}
    </button>
  ))}
</div>
```

Add `onSelectLayer: (layer: Layer) => void` to props. Import `layerCopy` from constants.

**Step 3: Add LayerToggle to VerificationWorkspace**

Same pattern — add the layer toggle in an appropriate location within the verification workspace.

**Step 4: Update App.tsx**

Remove `showLayerRail` prop from Sidebar JSX. Pass `selectedLayer` and `onSelectLayer` to AssignmentsWorkspace and VerificationWorkspace.

**Step 5: Add CSS for centered layer toggle**

```css
.layer-toggle--centered {
  display: flex;
  justify-content: center;
  gap: 0;
  margin-top: 12px;
}
```

**Step 6: Type check**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/components/Sidebar.tsx src/components/AssignmentsWorkspace.tsx src/components/VerificationWorkspace.tsx src/App.tsx src/App.css
git commit -m "feat: move layer switcher from sidebar to below mouse visualization"
```

---

## Phase 3: Profiles Workspace Improvements

### Task 5: Add file picker for exe selection + hide priority in "Advanced"

Add a "Browse..." button next to the exe field that opens a native file dialog. Hide priority fields under a collapsible "Advanced" section. Add tooltip to title filter field.

**Files:**
- Modify: `src-tauri/capabilities/default.json` (add `dialog:allow-open`)
- Modify: `src/components/ProfilesWorkspace.tsx:272-296, 127-147, 315-335, 337-357`

**Step 1: Add dialog:allow-open permission**

In `capabilities/default.json`, add `"dialog:allow-open"` to the permissions array.

**Step 2: Import Tauri dialog in ProfilesWorkspace**

```typescript
import { open } from "@tauri-apps/plugin-dialog";
```

**Step 3: Replace exe text field with field + browse button**

Replace the exe `<label className="field">` block (lines 272-296) with:

```tsx
<div className="field">
  <span className="field__label">Исполняемый файл</span>
  <div className="field__row">
    <input
      type="text"
      value={selectedAppMapping.exe}
      placeholder="example.exe"
      onChange={(event) => {
        updateDraft((config) =>
          upsertAppMapping(config, {
            ...selectedAppMapping,
            exe: event.target.value,
          }),
        );
      }}
      onBlur={(event) => {
        if (!event.target.value.trim()) {
          updateDraft((config) =>
            upsertAppMapping(config, {
              ...selectedAppMapping,
              exe: "example.exe",
            }),
          );
        }
      }}
    />
    <button
      type="button"
      className="action-button action-button--small"
      onClick={async () => {
        const selected = await open({
          title: "Выберите исполняемый файл",
          filters: [{ name: "Программы", extensions: ["exe", "lnk"] }],
          multiple: false,
        });
        if (typeof selected === "string") {
          const exeName = selected.split(/[/\\]/).pop() ?? selected;
          updateDraft((config) =>
            upsertAppMapping(config, {
              ...selectedAppMapping,
              exe: exeName.toLowerCase(),
            }),
          );
        }
      }}
    >
      Обзор…
    </button>
  </div>
</div>
```

**Step 4: Wrap priority fields in collapsible "Advanced" section**

For both profile priority (lines 127-147) and app mapping priority (lines 315-335), wrap them in a `<details>` element:

```tsx
<details className="advanced-section">
  <summary className="advanced-section__toggle">
    Дополнительные настройки
  </summary>
  <label className="field">
    <span className="field__label">
      Приоритет
      <span className="field__hint" title="Чем выше число, тем предпочтительнее профиль/правило при конфликте нескольких совпадений">
        ?
      </span>
    </span>
    <input type="number" ... />
  </label>
</details>
```

**Step 5: Add tooltip to title filter field**

Replace the "Фильтры заголовка" label with:

```tsx
<span className="field__label">
  Фильтры заголовка
  <span className="field__hint" title="Через запятую. Правило сработает, только если заголовок окна содержит ВСЕ указанные фрагменты. Например: «Pull Request, Review» — сработает для VS Code с заголовком «Pull Request Review — user/repo»">
    ?
  </span>
</span>
```

**Step 6: Add CSS for new elements**

```css
.field__row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.field__row > input {
  flex: 1;
}

.field__hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--c-surface-2);
  color: var(--c-text-muted);
  font-size: 11px;
  cursor: help;
  margin-left: 6px;
  vertical-align: middle;
}

.advanced-section {
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  padding: 0;
}

.advanced-section[open] {
  padding-bottom: 12px;
}

.advanced-section__toggle {
  padding: 8px 12px;
  cursor: pointer;
  font-size: var(--fs-small);
  color: var(--c-text-secondary);
  user-select: none;
}

.advanced-section__toggle:hover {
  color: var(--c-text);
}

.advanced-section > .field {
  padding: 0 12px;
}
```

**Step 7: Install @tauri-apps/plugin-dialog (if not already in package.json)**

Run: `npm ls @tauri-apps/plugin-dialog` — if not found:
Run: `npm install @tauri-apps/plugin-dialog`

**Step 8: Type check**

Run: `npx tsc --noEmit`

**Step 9: Commit**

```bash
git add src-tauri/capabilities/default.json src/components/ProfilesWorkspace.tsx src/App.css package.json package-lock.json
git commit -m "feat: exe file picker, collapsible priority, title filter tooltip"
```

---

### Task 6: Show profile name in sidebar selector

The current sidebar shows a `<select>` dropdown which on some platforms doesn't show the selected value prominently. Make it more visible.

**Files:**
- Modify: `src/components/Sidebar.tsx:63-92`
- Modify: `src/App.css`

**Step 1: Style the profile select to be more prominent**

Replace the current profile section (lines 63-92) with a more visible design:

```tsx
<div className="sidebar__section">
  <span className="sidebar__section-label">Профиль</span>
  <div className="sidebar__profile-row">
    <select
      className="sidebar__profile-select"
      value={effectiveProfileId ?? ""}
      disabled={isSessionActive}
      onChange={(event) => {
        startTransition(() => {
          onSelectProfile(event.target.value);
        });
      }}
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
    {isProfilesMode ? (
      <button
        type="button"
        className="nav-item nav-item--icon"
        onClick={onCreateProfile}
        title="Добавить профиль"
      >
        +
      </button>
    ) : null}
  </div>
</div>
```

**Step 2: Add CSS for prominent profile selector**

```css
.sidebar__profile-select {
  flex: 1;
  background: var(--c-surface-1);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: var(--fs-base);
  font-weight: 600;
  appearance: auto;
  cursor: pointer;
}

.sidebar__profile-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
```

**Step 3: Type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/App.css
git commit -m "feat: prominent profile name in sidebar selector"
```

---

## Phase 4: Double-Click to Assign

### Task 7: Add double-click on hotspot to open ActionPicker

Single click selects, double-click opens the action picker. Clicking a callout label also opens the picker.

**Files:**
- Modify: `src/components/MouseVisualization.tsx`

**Step 1: Add double-click handler to hotspot buttons**

On each hotspot `<button>`, add:

```tsx
onDoubleClick={(e) => {
  e.preventDefault();
  onOpenActionPicker(entry.control.id);
}}
```

The callout labels (rendered in Task 3) should already have `onClick={() => onOpenActionPicker(entry.control.id)}`.

**Step 2: Verify in browser**

- Single-click a button → selects it (callout highlights)
- Double-click a button → opens ActionPicker modal
- Click callout label → opens ActionPicker modal

**Step 3: Commit**

```bash
git add src/components/MouseVisualization.tsx
git commit -m "feat: double-click hotspot or click callout to open action picker"
```

---

## Phase 5: Fixed Layout Height

### Task 8: Prevent workspace height jumps when switching tabs

The `.workspace` element changes height when switching between tabs because content differs. Fix by setting a minimum height.

**Files:**
- Modify: `src/App.css`

**Step 1: Add fixed min-height to workspace**

```css
.workspace {
  min-height: calc(100vh - 60px); /* toolbar height */
  align-content: start;
}
```

This ensures the sidebar doesn't jump because the workspace always fills at least the viewport height.

**Step 2: Verify in browser**

Switch between all 4 tabs rapidly. The sidebar should not jump or change height.

**Step 3: Commit**

```bash
git add src/App.css
git commit -m "fix: fixed workspace min-height to prevent layout jumps"
```

---

## Summary

| Task | What | Priority |
|------|------|----------|
| 1 | Fix stale label in ActionPickerModal | BUG |
| 2 | Russian button names + remove verification badge | HIGH |
| 3 | Synapse-style callout lines + single-column assignments | HIGH |
| 4 | Move layer switcher below mouse | HIGH |
| 5 | Exe file picker + hide priority + title filter tooltip | MEDIUM |
| 6 | Prominent profile name in sidebar | MEDIUM |
| 7 | Double-click hotspot to open ActionPicker | HIGH |
| 8 | Fixed workspace height | BUG |

**Dependencies:**
- Task 1: standalone
- Task 2: standalone (but before Task 3)
- Task 3: depends on Task 2 (uses displayNameForControl)
- Task 4: depends on Task 3 (AssignmentsWorkspace layout)
- Task 5: standalone
- Task 6: standalone
- Task 7: depends on Task 3 (MouseVisualization rewrite)
- Task 8: standalone

**Execution order:** 1 → 2 → 3 → 4 → 7 → 8 (sequential chain), 5 and 6 can be parallel at any point.
