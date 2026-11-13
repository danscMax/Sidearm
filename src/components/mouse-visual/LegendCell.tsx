// A single button-legend cell, shared by the vertical `LabelColumn` and the
// side-view 4×3 grid. The wrappers differ (column vs grid rows); the cell body
// — class flags, heat tint, drag/click handlers, badge + label + heat count —
// lives here so it is defined once.

import type { ControlId } from "../../lib/config";
import type { ControlSurfaceEntry } from "../../lib/constants";
import type { ControlInteractions } from "../../hooks/useControlInteractions";
import { useTranslation } from "react-i18next";
import { legendCellClass } from "../../lib/mouse-visual";
import { GestureIcon } from "./GestureIcon";
import { HeatCount } from "./HeatCount";

const GESTURE_NAME = { longPress: "picker.gestureLongPress", doublePress: "picker.gestureDoublePress", triplePress: "picker.gestureTriplePress" } as const;

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
  const { t } = useTranslation();
  const { hoveredId, dragOverId, getInteractionProps, applyHeatBg } = interaction;
  // A chip's own bubble (the cell's hides while it shows), or a native title in the side grid.
  const tip = (text: string) => (nativeTooltip ? { title: text } : { "data-tip": text });
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
      <span className="btn-legend__text">
        <span className="btn-legend__main">
          <span className="btn-legend__label">{label}</span>
          {entry.sidearmOnly ? (
            <span className="btn-legend__live" {...tip(t("mouseVisual.sidearmOnly"))}>
              <GestureIcon mark="live" />
            </span>
          ) : null}
        </span>
        {/* The other press patterns, one chip each: what the hold / double / triple press does. */}
        {entry.extras?.length ? (
          <span className="btn-legend__gestures">
            {entry.extras.map((extra) => (
              <span key={extra.gesture} className="btn-legend__gesture" {...tip(`${t(GESTURE_NAME[extra.gesture])}: ${extra.action.displayName}`)}>
                <GestureIcon mark={extra.gesture} />
                <span className="btn-legend__gesture-name">{extra.action.displayName}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <HeatCount
        controlId={controlId}
        executionCounts={executionCounts}
        heatmapEnabled={heatmapEnabled}
      />
    </button>
  );
}
