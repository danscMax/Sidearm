# UI Improvements (8 Tasks) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Modernize the Assignments workspace: better layer toggle, tooltips, search, toolbar, runtime status, Cmd+K hint, tab animation, action type indicators.

**Architecture:** All changes are CSS + React component modifications. No Rust/backend changes. Layer-scoped CSS variables (`--layer-rgb`, `--layer-accent`) already exist on `.workspace__center[data-layer]`.

**Tech Stack:** React 19, TypeScript, CSS (no component library), Tauri v2

---

### Task 1: Move layer toggle above visualization, add binding counts

**Files:**
- Modify: `src/components/AssignmentsWorkspace.tsx`
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/App.css`

**Context:** Currently the layer toggle is below the mouse visualization (AssignmentsWorkspace.tsx:97-108). It should move INTO MouseVisualization, above the view tabs, merged into a single control bar. Show count of assigned bindings per layer.

**Step 1: Add layer toggle props to MouseVisualization**

In `MouseVisualizationProps` (MouseVisualization.tsx), add:
```ts
onSelectLayer: (layer: Layer) => void;
```

`selectedLayer` is already a prop (currently unused as `_selectedLayer`). Remove the underscore prefix — it's now needed.

**Step 2: Merge layer toggle + view tabs into one control bar**

Replace the current `mouse-visual-tabs__nav` with a combined bar:
```tsx
<div className="mouse-visual-tabs__nav">
  {/* Layer toggle — left side */}
  <div className="layer-toggle">
    {layerCopy.map((layer) => {
      const count = entries.filter((e) =>
        e.binding?.enabled && e.action && e.action.type !== "disabled"
      ).length;
      // Note: entries are already filtered by selectedLayer in parent,
      // so we only know the count for the CURRENT layer.
      // For the other layer's count, we'd need additional props.
      // Simpler: just show the active layer indicator without counts for now,
      // or pass both layer entry counts from parent.
      return (
        <button
          key={layer.value}
          type="button"
          className={`layer-toggle__btn layer-toggle__btn--${layer.value}${
            selectedLayer === layer.value ? " layer-toggle__btn--active" : ""
          }`}
          onClick={() => onSelectLayer(layer.value)}
        >
          {layer.label}
        </button>
      );
    })}
  </div>
  {/* View tabs — right side */}
  <div className="view-tabs">
    <button ... >Верхняя панель</button>
    <button ... >Боковая клавиатура</button>
  </div>
</div>
```

**Step 3: Remove layer toggle from AssignmentsWorkspace**

Delete the `<div className="layer-toggle layer-toggle--centered">` block (lines 97-108) and pass `onSelectLayer` to MouseVisualization instead.

**Step 4: Update CSS**

`.mouse-visual-tabs__nav` becomes a flex row with `justify-content: space-between`. Left side: layer toggle. Right side: view tabs. Both use pill-style buttons.

```css
.mouse-visual-tabs__nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  gap: 12px;
}
```

**Step 5: Build check + visual verification**

Run: `npx tsc --noEmit && npx vite build`

---

### Task 2: Add expanded action preview tooltips on legend cells

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/App.css`

**Context:** Currently `title` attributes show raw text. Replace with CSS tooltips that show action type + full description on hover. Use a `data-tooltip` attribute + CSS `::after` pseudo-element.

**Step 1: Build tooltip text helper**

```ts
function tooltipText(entry: ControlSurfaceEntry): string {
  const name = displayNameForControl(entry.control);
  if (!entry.action || entry.action.type === "disabled" || !entry.binding?.enabled) {
    return `${name}\nНе назначено`;
  }
  const cat = ACTION_CATEGORIES.find((c) => c.actionType === entry.action!.type);
  return `${name}\n${cat?.label ?? ""}: ${entry.action.pretty}`;
}
```

Import `ACTION_CATEGORIES` from constants.

**Step 2: Add `data-tooltip` to legend cells**

Replace `title={...}` with `data-tooltip={tooltipText(entry)}` on each `<button className="btn-legend__cell">`. Remove the `title` attribute.

**Step 3: Add CSS tooltip**

```css
.btn-legend__cell {
  position: relative;
}

.btn-legend__cell[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  background: rgba(0, 0, 0, 0.85);
  color: var(--c-text-bright);
  font-size: var(--fs-caption);
  white-space: pre-line;
  pointer-events: none;
  z-index: 10;
  max-width: 220px;
  line-height: 1.4;
}
```

**Step 4: Build check + visual verification**

---

### Task 3: Add search/filter in Action Picker modal

**Files:**
- Modify: `src/components/ActionPickerModal.tsx`
- Modify: `src/App.css`

**Context:** ActionPickerModal has 8 category tabs (line 421). Add a search input above them that filters categories by label match + highlights matching category.

**Step 1: Add search state**

In ActionPickerModal, add:
```ts
const [searchQuery, setSearchQuery] = useState("");
```

**Step 2: Add search input above category nav**

Insert before the category buttons (line ~420):
```tsx
<input
  className="action-picker__search"
  type="text"
  placeholder="Поиск действия..."
  value={searchQuery}
  onChange={(e) => setSearchQuery(e.target.value)}
  autoComplete="off"
/>
```

**Step 3: Filter visible categories**

```ts
const filteredCategories = searchQuery
  ? ACTION_CATEGORIES.filter((cat) =>
      cat.label.toLowerCase().includes(searchQuery.toLowerCase())
    )
  : ACTION_CATEGORIES;
```

Replace `ACTION_CATEGORIES.map(...)` in the nav with `filteredCategories.map(...)`. Auto-select first match if current category is filtered out.

**Step 4: Add CSS**

```css
.action-picker__search {
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--c-card-border);
  border-radius: var(--radius-xs);
  background: var(--c-surface-alt);
  color: var(--c-text);
  font-size: var(--fs-body-sm);
}

.action-picker__search:focus {
  border-color: var(--c-border-hover);
  outline: none;
}
```

**Step 5: Build check + visual verification**

---

### Task 4: Redesign toolbar with icons and grouped actions

**Files:**
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/App.css`

**Context:** Current toolbar (Toolbar.tsx:28-75) has 5 flat buttons: Load, ↩, ↪, Discard, Save. Redesign: group Undo/Redo together, make Save prominent, hide Load/Discard in a "⋯" overflow menu.

**Step 1: Add overflow state**

```ts
const [overflowOpen, setOverflowOpen] = useState(false);
```

**Step 2: Restructure toolbar layout**

```tsx
<div className="toolbar">
  <span className="toolbar__heading">{heading}</span>
  <div className="toolbar__actions">
    {/* Undo/Redo group */}
    <div className="toolbar__group">
      <button className="toolbar__btn" disabled={undoCount === 0} onClick={onUndo} title="Отменить (Ctrl+Z)">
        <span className="toolbar__icon">↩</span>
        {undoCount > 0 && <span className="toolbar__badge">{undoCount}</span>}
      </button>
      <button className="toolbar__btn" disabled={redoCount === 0} onClick={onRedo} title="Повторить (Ctrl+Y)">
        <span className="toolbar__icon">↪</span>
      </button>
    </div>
    {/* Save — primary */}
    <button className={`toolbar__btn toolbar__btn--primary${isDirty ? " toolbar__btn--primary--dirty" : ""}`}
      disabled={!isDirty || viewState !== "idle"} onClick={onSave}>
      Сохранить
    </button>
    {/* Overflow */}
    <div className="toolbar__overflow">
      <button className="toolbar__btn" onClick={() => setOverflowOpen(!overflowOpen)}>⋯</button>
      {overflowOpen && (
        <div className="toolbar__overflow-menu">
          <button onClick={() => { onLoad(); setOverflowOpen(false); }}>Загрузить с диска</button>
          <button onClick={() => { onDiscard(); setOverflowOpen(false); }} disabled={!isDirty}>Отменить изменения</button>
        </div>
      )}
    </div>
  </div>
</div>
```

**Step 3: Update CSS**

- `.toolbar__actions` — flex row with gap
- `.toolbar__group` — flex row, border-radius grouped buttons
- `.toolbar__badge` — small counter pill on undo
- `.toolbar__overflow` — position: relative
- `.toolbar__overflow-menu` — absolute dropdown, dark bg, border

**Step 4: Close overflow on outside click**

Add `useEffect` with document click listener when `overflowOpen` is true.

**Step 5: Build check + visual verification**

---

### Task 5: Make runtime status more visible with start/stop control

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx` (pass start/stop handlers to Sidebar)
- Modify: `src/App.css`

**Context:** Runtime status is a tiny dot + text at sidebar bottom (Sidebar.tsx:81-84). `handleStartRuntime`/`handleStopRuntime` exist in App.tsx but aren't passed to Sidebar.

**Step 1: Add start/stop props to Sidebar**

```ts
interface SidebarProps {
  // existing...
  onToggleRuntime: () => void;
}
```

**Step 2: Pass handler from App.tsx**

In App.tsx where `<Sidebar>` is rendered (~line 392), add:
```tsx
onToggleRuntime={() => {
  if (runtimeSummary.status === "running") handleStopRuntime();
  else handleStartRuntime();
}}
```

**Step 3: Redesign runtime status in Sidebar**

Replace the small dot (lines 81-84) with a clickable banner:
```tsx
<button
  className={`sidebar__runtime sidebar__runtime--${runtimeStatus === "running" ? "running" : "stopped"}`}
  onClick={onToggleRuntime}
  type="button"
>
  <span className="sidebar__runtime-dot" />
  <span className="sidebar__runtime-label">
    {runtimeStatus === "running" ? "Перехват активен" : "Перехват остановлен"}
  </span>
  <span className="sidebar__runtime-action">
    {runtimeStatus === "running" ? "Стоп" : "Старт"}
  </span>
</button>
```

**Step 4: Update CSS**

```css
.sidebar__runtime {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--c-card-border);
  border-radius: var(--radius-xs);
  background: var(--c-card-bg);
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}

.sidebar__runtime--running {
  border-color: rgba(117, 194, 104, 0.3);
  background: rgba(117, 194, 104, 0.06);
}

.sidebar__runtime--stopped {
  border-color: rgba(224, 85, 85, 0.3);
  background: rgba(224, 85, 85, 0.06);
}

.sidebar__runtime-action {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
```

**Step 5: Build check + visual verification**

---

### Task 6: Add Ctrl+K hint for Command Palette

**Files:**
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/App.css`

**Context:** CommandPalette exists and opens with Ctrl+K (App.tsx:179), but there's no visual hint.

**Step 1: Add callback prop to Toolbar**

```ts
interface ToolbarProps {
  // existing...
  onOpenCommandPalette?: () => void;
}
```

**Step 2: Pass from App.tsx**

```tsx
<Toolbar onOpenCommandPalette={() => setCommandPaletteOpen(true)} ... />
```

**Step 3: Add search button to toolbar**

Insert before the actions group:
```tsx
<button
  className="toolbar__btn toolbar__btn--search"
  onClick={onOpenCommandPalette}
  title="Палитра команд (Ctrl+K)"
>
  <span className="toolbar__icon">⌘</span>
  <span className="toolbar__shortcut">Ctrl+K</span>
</button>
```

**Step 4: CSS**

```css
.toolbar__btn--search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px dashed var(--c-card-border);
  border-radius: var(--radius-xs);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}

.toolbar__shortcut {
  font-size: var(--fs-micro);
  opacity: 0.6;
  font-family: var(--font-mono);
}
```

**Step 5: Build check + visual verification**

---

### Task 7: Add crossfade animation for tab switching

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/App.css`

**Context:** Tab content swaps instantly. Add a CSS fade transition.

**Step 1: Wrap tab content in animated container**

```tsx
<div className="mouse-visual-tabs__content" key={activeTab}>
  {activeTab === "top" ? (...) : (...)}
</div>
```

**Step 2: Add CSS animation**

```css
.mouse-visual-tabs__content {
  animation: tab-fade-in 200ms ease-out;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

@keyframes tab-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Respect `prefers-reduced-motion` — already handled globally in App.css (line ~1759).

**Step 3: Build check + visual verification**

---

### Task 8: Add action type color indicators in legend cells

**Files:**
- Modify: `src/components/MouseVisualization.tsx`
- Modify: `src/App.css`

**Context:** Legend cells show badge + text but no visual indicator of action TYPE. The hotspot dots already have per-type colors (App.css:1116-1124). Reuse same color scheme for a small dot/stripe on legend cells.

**Step 1: Add data-action-type attribute to legend cells**

In `renderLabelColumn` and `renderSideLegendGrid`, add to each button:
```tsx
data-action-type={entry.action?.type ?? ""}
```

**Step 2: Add CSS color stripe**

Use a left border as a type indicator:
```css
.btn-legend__cell[data-action-type="shortcut"] { border-left: 3px solid rgba(143, 211, 232, 0.7); }
.btn-legend__cell[data-action-type="mouseAction"] { border-left: 3px solid rgba(183, 226, 107, 0.7); }
.btn-legend__cell[data-action-type="textSnippet"] { border-left: 3px solid rgba(231, 196, 111, 0.7); }
.btn-legend__cell[data-action-type="sequence"] { border-left: 3px solid rgba(196, 153, 255, 0.7); }
.btn-legend__cell[data-action-type="launch"] { border-left: 3px solid rgba(255, 153, 102, 0.7); }
.btn-legend__cell[data-action-type="mediaKey"] { border-left: 3px solid rgba(255, 153, 204, 0.7); }
.btn-legend__cell[data-action-type="profileSwitch"] { border-left: 3px solid rgba(153, 204, 255, 0.7); }
.btn-legend__cell[data-action-type="menu"] { border-left: 3px solid rgba(204, 204, 153, 0.7); }
.btn-legend__cell[data-action-type="disabled"] { border-left: 3px solid rgba(160, 160, 160, 0.4); }
```

This reuses exact colors from `.mouse-visual__hotspot--type-*` (App.css:1116-1124) for consistency.

**Step 3: Build check + visual verification**

---

## Execution Order

Tasks are mostly independent. Recommended order to minimize merge conflicts:

1. **Task 1** (layer toggle) — changes AssignmentsWorkspace + MouseVisualization structure
2. **Task 7** (tab animation) — small CSS + wrapper div
3. **Task 8** (type indicators) — data attribute + CSS only
4. **Task 2** (tooltips) — data attribute + CSS only
5. **Task 6** (Ctrl+K hint) — small Toolbar addition
6. **Task 4** (toolbar redesign) — larger Toolbar rewrite
7. **Task 5** (runtime status) — Sidebar + App.tsx prop threading
8. **Task 3** (action picker search) — modal changes, independent

## Commit Strategy

One commit per task: `ui: <short description>`. Example: `ui: move layer toggle above visualization`.
