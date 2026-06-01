// Shared interaction logic for the two mouse-layout visualizers. Owns the
// hover / drag-over state and the per-control event-handler bundle (click,
// double-click, context-menu, hover, drag-and-drop) so the identical handlers
// are defined once instead of being copied into every button/cell/region.

import { useState } from "react";
import type { Action, Binding, ControlId } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { buildBindingDragData, HEAT_TINT, parseBindingDragData } from "../lib/mouse-visual";

/** Event-handler bundle spread onto an interactive control (a `<button>` or SVG `<g>`). */
export interface ControlInteractionProps {
  onClick: (e: React.MouseEvent<Element>) => void;
  onDoubleClick: (e: React.MouseEvent<Element>) => void;
  /** Omitted when the control opts out of a context menu (e.g. the side grid). */
  onContextMenu?: (e: React.MouseEvent<Element>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onDragStart: (e: React.DragEvent<Element>) => void;
  onDragOver: (e: React.DragEvent<Element>) => void;
  onDragEnter: (e: React.DragEvent<Element>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<Element>) => void;
}

export interface UseControlInteractionsParams {
  entries: ControlSurfaceEntry[];
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
  onOpenActionPicker: (id: ControlId, binding: Binding | null) => void;
  onContextMenu?: (
    id: ControlId,
    binding: Binding | null,
    action: Action | null,
    x: number,
    y: number,
  ) => void;
  onDropBinding?: (targetControlId: ControlId, sourceActionId: string) => void;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
}

export interface ControlInteractions {
  entryMap: Map<ControlId, ControlSurfaceEntry>;
  hoveredId: ControlId | null;
  dragOverId: ControlId | null;
  getInteractionProps: (id: ControlId, opts?: { contextMenu?: boolean }) => ControlInteractionProps;
  /** Applies (or clears) the heatmap background tint via CSSOM, CSP-safe. */
  applyHeatBg: (el: HTMLElement | null, id: ControlId) => void;
}

export function useControlInteractions({
  entries,
  onSelectControl,
  onToggleMultiSelect,
  onOpenActionPicker,
  onContextMenu,
  onDropBinding,
  executionCounts,
  heatmapEnabled,
}: UseControlInteractionsParams): ControlInteractions {
  const [hoveredId, setHoveredId] = useState<ControlId | null>(null);
  const [dragOverId, setDragOverId] = useState<ControlId | null>(null);

  const entryMap = new Map(entries.map((e) => [e.control.id, e]));

  function applyHeatBg(el: HTMLElement | null, id: ControlId): void {
    if (!el) return;
    const hot = !!heatmapEnabled && !!executionCounts && (executionCounts.get(id) ?? 0) > 0;
    if (hot) {
      el.style.setProperty("background-color", HEAT_TINT);
    } else {
      el.style.removeProperty("background-color");
    }
  }

  function getInteractionProps(
    id: ControlId,
    opts?: { contextMenu?: boolean },
  ): ControlInteractionProps {
    const props: ControlInteractionProps = {
      onClick: (e) => {
        if (e.ctrlKey || e.metaKey) onToggleMultiSelect(id);
        else onSelectControl(id);
      },
      onDoubleClick: (e) => {
        e.preventDefault();
        onOpenActionPicker(id, entryMap.get(id)?.binding ?? null);
      },
      onMouseEnter: () => setHoveredId(id),
      onMouseLeave: () => setHoveredId(null),
      onDragStart: (e) => {
        const entry = entryMap.get(id);
        if (!entry?.binding || !entry?.action) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/json", buildBindingDragData(entry.action.id));
      },
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragEnter: (e) => {
        e.preventDefault();
        setDragOverId(id);
      },
      onDragLeave: () => setDragOverId(null),
      onDrop: (e) => {
        e.preventDefault();
        setDragOverId(null);
        const actionId = parseBindingDragData(e.dataTransfer.getData("application/json"));
        if (actionId != null) onDropBinding?.(id, actionId);
      },
    };
    // Side-grid cells have never had a context menu — let callers opt out.
    if (opts?.contextMenu !== false) {
      props.onContextMenu = (e) => {
        e.preventDefault();
        const entry = entryMap.get(id);
        onContextMenu?.(id, entry?.binding ?? null, entry?.action ?? null, e.clientX, e.clientY);
      };
    }
    return props;
  }

  return { entryMap, hoveredId, dragOverId, getInteractionProps, applyHeatBg };
}
