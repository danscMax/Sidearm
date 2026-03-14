# Design: 4 Features — Context Menu, Profile Export, Heatmap, Drag-n-Drop

**Date:** 2026-03-14
**Status:** Approved

---

## Feature 1: Right-click context menu on hotspots

**Goal:** Quick actions on mouse button hotspots without opening the full editor.

**Existing infrastructure:** `ContextMenu.tsx` component with positioning, escape close, outside-click close. Used in ProfilesWorkspace for app mapping cards.

**Menu items — button WITH binding:**

| Item | Action | Details |
|---|---|---|
| Редактировать | Open ActionPickerModal | Same as double-click |
| Копировать привязку | Save binding+action to clipboard-state | React state, not system clipboard |
| Копировать на Hypershift / Standard | Duplicate binding to the other layer | Uses `upsertBinding()` with swapped layer |
| Отключить / Включить | Toggle `binding.enabled` | Via `updateDraft()` |
| *(separator)* | | |
| Очистить | Delete binding | Danger-styled item |

**Menu items — button WITHOUT binding:**

| Item | Action |
|---|---|
| Назначить действие | Open ActionPickerModal |
| Вставить привязку | Paste from clipboard-state (grayed out if empty) |

**Implementation:**
- Add `onContextMenu` to hotspot button groups in both `MouseVisualization.tsx` and `MouseVisualizationSvg.tsx`
- Clipboard-state: `useState<{binding: Binding, action: Action} | null>` lifted to parent
- Reuse existing `ContextMenu` component

---

## Feature 2: Profile import/export

**Goal:** Export a single profile to JSON file, import from file with merge.

**Export flow:**
1. Button in profile section (toolbar or context menu)
2. Collect: profile object + bindings (by profileId) + actions (by actionRef from those bindings) + appMappings (by profileId)
3. Wrap in `{ version: 2, exportedAt, profile, bindings, actions, appMappings }`
4. `tauri-plugin-dialog` save dialog → `write_text_file` IPC
5. Show success toast with path

**Import flow:**
1. Button "Импорт профиля" in profile section
2. `tauri-plugin-dialog` open dialog → `read_text_file` IPC
3. Parse JSON, validate structure (version, required fields)
4. On ID collision: generate new IDs for profile/bindings/actions, update refs
5. Merge into current config via `updateDraft()`
6. Auto-select imported profile

**File format:** Subset of AppConfig — same schema, machine-readable, human-editable.

---

## Feature 3: Button usage statistics / heatmap

**Goal:** Visualize how often each button is pressed during a runtime session.

**Data collection:**
- In-memory `Map<ControlId, number>` in React, fed by `action_executed` events
- Increment on each `ActionExecutionEvent` with `mode: "live"`
- Reset on profile switch or manual "Reset" button

**Visualization:**
- Color overlay on hotspots: cold (low count) → warm (high count)
- Use CSS opacity or background-color intensity based on normalized count (0-1 scale relative to max)
- Optional: show count number as small badge on hotspot

**Persistence:** localStorage between sessions (optional, can start without).

**Toggle:** Heatmap mode toggle in toolbar — when off, normal colors; when on, heatmap overlay.

---

## Feature 4: Drag-and-drop action assignment

**Goal:** Drag an action from one hotspot to another, or from a list to a hotspot.

**Implementation:**
- HTML5 DataTransfer API (pattern already exists in ProfilesWorkspace for .exe drag)
- No external library (React DnD, dnd-kit) — keep it native

**Drag sources:**
- Hotspot with existing binding (drag to copy/move)
- Action list in picker (future)

**Drop targets:**
- Any hotspot on mouse visualization

**Data format:**
```json
{ "type": "binding", "bindingId": "...", "actionId": "..." }
```

**Visual feedback:**
- `dragover` CSS class on drop target hotspot
- Ghost image from browser default (or custom via `setDragImage`)

**Drop behavior:** Assign the dragged action to the target binding (upsert via `updateDraft`).

---

## Priority order

1. **Context menu** — lowest effort, highest UX impact, foundation exists
2. **Profile export/import** — table stakes, pattern exists
3. **Heatmap** — unique differentiator, medium effort
4. **Drag-and-drop** — UX polish, can be deferred
