// A single button-legend cell, shared by the vertical `LabelColumn` and the
// side-view 4×3 grid. The wrappers differ (column vs grid rows); the cell body
// — class flags, heat tint, drag/click handlers, badge + label + heat count —
// lives here so it is defined once.

import type { ControlId } from "../../lib/config";
import type { ControlSurfaceEntry } from "../../lib/constants";
import type { ControlInteractions } from "../../hooks/useControlInteractions";
import { legendCellClass } from "../../lib/mouse-visual";
import { HeatCount } from "./HeatCount";

interface LegendCellProps {
  entry: ControlSurfaceEntry;
  controlId: ControlId;
  interaction: ControlInteractions;
  selected: boolean;
  badge: string;
  label: string;
  tooltip: string;
  /** Use the native `title` attribute (side grid) instead of the data-tooltip CSS bubble. */
  nativeTooltip?: boolean;
  /** Whether right-click opens the context menu. False for the side grid. */
  contextMenu?: boolean;
  /** Photo mode only: dim controls outside the match set. */
  dimmed?: boolean;
  /** Photo mode only: flag a conflicting binding. */
  conflict?: boolean;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
}

export function LegendCell({
  entry,
  controlId,
  interaction,
  selected,
  badge,
  label,
  tooltip,
  nativeTooltip,
  contextMenu = true,
  dimmed,
  conflict,
  executionCounts,
  heatmapEnabled,
}: LegendCellProps) {
  const { hoveredId, dragOverId, getInteractionProps, applyHeatBg } = interaction;
  const hovered = hoveredId === controlId;
  const dragOver = dragOverId === controlId;
  return (
    <button
      type="button"
      className={legendCellClass({ selected, hovered, dragOver, dimmed, conflict })}
      data-action-type={entry.action?.type ?? ""}
      {...(nativeTooltip ? { title: tooltip } : { "data-tooltip": tooltip })}
      ref={(el) => applyHeatBg(el, controlId)}
      draggable={!!entry.binding && !!entry.action}
      {...getInteractionProps(controlId, { contextMenu })}
    >
      <span className="btn-legend__badge">{badge}</span>
      <span className="btn-legend__label">{label}</span>
      <HeatCount
        controlId={controlId}
        executionCounts={executionCounts}
        heatmapEnabled={heatmapEnabled}
      />
    </button>
  );
}
