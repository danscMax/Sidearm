import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Action, Binding, ControlId, Layer } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { topViewHotspots, sideViewHotspots, combinedViewHotspots } from "../lib/constants";
import { displayNameForControl, surfacePrimaryLabel } from "../lib/labels";
import { MouseVisualizationSvg } from "./MouseVisualizationSvg";
import {
  actionLabel,
  COMBINED_LEFT_BUTTONS,
  COMBINED_RIGHT_BUTTONS,
  TOP_LEFT_BUTTONS,
  TOP_RIGHT_BUTTONS,
  type TriggerBadgeLabels,
  type ViewTab,
} from "../lib/mouse-visual";
import { useControlInteractions } from "../hooks/useControlInteractions";
import { HeatCount } from "./mouse-visual/HeatCount";
import { LabelColumn } from "./mouse-visual/LabelColumn";
import { LegendCell } from "./mouse-visual/LegendCell";
import { LayerPills } from "./mouse-visual/LayerPills";
import { ViewTabPills } from "./mouse-visual/ViewTabPills";

type VisualMode = "photo" | "schematic";

interface MouseVisualizationProps {
  entries: ControlSurfaceEntry[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  /** If set, controls not in the set are visually dimmed. Null = no filter. */
  matchedControlIds?: Set<ControlId> | null;
  /** Binding IDs that conflict with another binding on the same layer. */
  conflictBindingIds?: Set<string>;
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
  onOpenActionPicker: (id: ControlId, binding: Binding | null) => void;
  onSelectLayer: (layer: Layer) => void;
  onContextMenu?: (id: ControlId, binding: Binding | null, action: Action | null, x: number, y: number) => void;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
  onDropBinding?: (targetControlId: ControlId, sourceActionId: string) => void;
}

/** Side view: 4 columns × 3 rows matching the physical thumb-grid layout. */
const SIDE_LEGEND_GRID: ControlId[][] = [
  ["thumb_03", "thumb_06", "thumb_09", "thumb_12"],
  ["thumb_02", "thumb_05", "thumb_08", "thumb_11"],
  ["thumb_01", "thumb_04", "thumb_07", "thumb_10"],
];

export function MouseVisualization({
  entries,
  selectedLayer,
  multiSelectedControlIds,
  matchedControlIds,
  conflictBindingIds,
  onSelectControl,
  onToggleMultiSelect,
  onOpenActionPicker,
  onSelectLayer,
  onContextMenu,
  executionCounts,
  heatmapEnabled,
  onDropBinding,
}: MouseVisualizationProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>("combined");
  const [visualMode, setVisualMode] = useState<VisualMode>("photo");
  const interaction = useControlInteractions({
    entries,
    onSelectControl,
    onToggleMultiSelect,
    onOpenActionPicker,
    onContextMenu,
    onDropBinding,
    executionCounts,
    heatmapEnabled,
  });
  const { entryMap, hoveredId, dragOverId, getInteractionProps, applyHeatBg } = interaction;
  const triggerLabels: TriggerBadgeLabels = {
    hold: t("visualization.badgeHold"),
    chord: t("visualization.badgeChord"),
  };

  if (visualMode === "schematic") {
    return (
      <div className="mouse-visual-tabs" data-layer={selectedLayer}>
        <div className="mouse-visual-tabs__nav">
          <button
            type="button"
            className="view-mode-toggle view-mode-toggle--icon"
            onClick={() => setVisualMode("photo")}
            title={t("visualization.switchPhoto")}
            aria-label={t("visualization.switchPhoto")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><circle cx="10.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M1 11l3.5-3.5L7 10l3-4 5 5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <MouseVisualizationSvg
          entries={entries}
          selectedLayer={selectedLayer}
          multiSelectedControlIds={multiSelectedControlIds}
          onSelectControl={onSelectControl}
          onToggleMultiSelect={onToggleMultiSelect}
          onOpenActionPicker={onOpenActionPicker}
          onSelectLayer={onSelectLayer}
          onContextMenu={onContextMenu}
          executionCounts={executionCounts}
          heatmapEnabled={heatmapEnabled}
          onDropBinding={onDropBinding}
        />
      </div>
    );
  }

  function renderHotspotButtons(
    hotspots: Partial<Record<ControlId, { left: number; top: number; label: string; size?: "sm" | "lg" }>>,
  ) {
    return entries.map((entry) => {
      const pos = hotspots[entry.control.id];
      if (!pos) return null;

      const isAssigned = entry.binding && entry.binding.enabled && entry.action && entry.action.type !== "disabled";
      const actionType = entry.action?.type;
      const assignedClass = isAssigned
        ? ` mouse-visual__hotspot--assigned mouse-visual__hotspot--type-${actionType}`
        : " mouse-visual__hotspot--unassigned";
      const isSelected = entry.isSelected || multiSelectedControlIds.has(entry.control.id);
      const isHovered = hoveredId === entry.control.id;

      const isDragOver = dragOverId === entry.control.id;
      const isDimmed =
        matchedControlIds != null && !matchedControlIds.has(entry.control.id);
      const hasConflict =
        !!entry.binding && conflictBindingIds?.has(entry.binding.id);

      return (
        <button
          type="button"
          key={entry.control.id}
          className={`mouse-visual__hotspot${
            isSelected ? " mouse-visual__hotspot--selected" : assignedClass
          }${pos.size === "sm" ? " mouse-visual__hotspot--sm" : ""}${
            pos.size === "lg" ? " mouse-visual__hotspot--lg" : ""
          }${isHovered ? " mouse-visual__hotspot--hovered" : ""}${
            isDragOver ? " mouse-visual__hotspot--dragover" : ""
          }${isDimmed ? " mouse-visual__hotspot--dimmed" : ""}${
            hasConflict ? " mouse-visual__hotspot--conflict" : ""
          }`}
          ref={(el) => {
            if (el) {
              el.style.setProperty("--hotspot-left", `${pos.left}%`);
              el.style.setProperty("--hotspot-top", `${pos.top}%`);
            }
            applyHeatBg(el, entry.control.id);
          }}
          title={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
            entry.binding,
            entry.action,
          )}`}
          draggable={!!entry.binding && !!entry.action}
          {...getInteractionProps(entry.control.id)}
        >
          {pos.label}
          <HeatCount
            controlId={entry.control.id}
            executionCounts={executionCounts}
            heatmapEnabled={heatmapEnabled}
          />
        </button>
      );
    });
  }

  /** Renders a vertical column of btn-legend cells for the given control IDs. */
  function renderLabelColumn(
    controlIds: ControlId[],
    hotspots: Partial<Record<ControlId, { label: string }>>,
    side: "left" | "right",
  ) {
    return (
      <LabelColumn
        controlIds={controlIds}
        side={side}
        interaction={interaction}
        multiSelectedControlIds={multiSelectedControlIds}
        badgeFor={(id) => hotspots[id]?.label ?? id}
        actionLabelFor={(entry) => actionLabel(entry, { triggerLabels })}
        unassignedLabel={t("visualization.unassigned")}
        executionCounts={executionCounts}
        heatmapEnabled={heatmapEnabled}
        matchedControlIds={matchedControlIds}
        conflictBindingIds={conflictBindingIds}
      />
    );
  }

  /** Renders the 4×3 grid legend for the side view. */
  function renderSideLegendGrid(
    hotspots: Partial<Record<ControlId, { label: string }>>,
  ) {
    return (
      <div className="btn-legend">
        {SIDE_LEGEND_GRID.map((row, rowIdx) => (
          <div
            key={rowIdx}
            className="btn-legend__row"
            ref={(el) => {
              if (el) el.style.setProperty("--col-count", String(row.length));
            }}
          >
            {row.map((controlId) => {
              const entry = entryMap.get(controlId);
              if (!entry) return null;
              const selected = entry.isSelected || multiSelectedControlIds.has(controlId);
              const dimmed = matchedControlIds != null && !matchedControlIds.has(controlId);
              const conflict = !!entry.binding && (conflictBindingIds?.has(entry.binding.id) ?? false);
              return (
                <LegendCell
                  key={controlId}
                  entry={entry}
                  controlId={controlId}
                  interaction={interaction}
                  selected={selected}
                  badge={hotspots[controlId]?.label ?? controlId}
                  label={actionLabel(entry, { triggerLabels })}
                  tooltip={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
                    entry.binding,
                    entry.action,
                  )}`}
                  nativeTooltip
                  contextMenu={false}
                  dimmed={dimmed}
                  conflict={conflict}
                  executionCounts={executionCounts}
                  heatmapEnabled={heatmapEnabled}
                />
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mouse-visual-tabs" data-layer={selectedLayer}>
      <div className="mouse-visual-tabs__nav">
        <ViewTabPills activeTab={activeTab} onSelect={setActiveTab} />
        <button
          type="button"
          className="view-mode-toggle view-mode-toggle--icon"
          onClick={() => setVisualMode("schematic")}
          title={t("visualization.switchSchematic")}
          aria-label={t("visualization.switchSchematic")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </div>

      <div className="mouse-visual-tabs__content">
        {activeTab === "top" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(TOP_LEFT_BUTTONS, topViewHotspots, "left")}
            <div className="mouse-visual mouse-visual--top">
              <img
                className="mouse-visual__img"
                src="/assets/naga-top.png"
                alt="Razer Naga V2 HyperSpeed — top view"
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(topViewHotspots)}
              </div>
            </div>
            {renderLabelColumn(TOP_RIGHT_BUTTONS, topViewHotspots, "right")}
          </div>
        )}
        {activeTab === "side" && (
          <div className="mouse-view-panel">
            <div className="mouse-visual mouse-visual--side">
              <img
                className="mouse-visual__img"
                src="/assets/naga-side.png"
                alt="Razer Naga V2 HyperSpeed — thumb grid"
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(sideViewHotspots)}
              </div>
            </div>
            {renderSideLegendGrid(sideViewHotspots)}
          </div>
        )}
        {activeTab === "combined" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(COMBINED_LEFT_BUTTONS, combinedViewHotspots, "left")}
            <div className="mouse-visual mouse-visual--combined">
              <img
                className="mouse-visual__img"
                src="/assets/naga-combined.png"
                alt="Razer Naga V2 HyperSpeed — all buttons"
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(combinedViewHotspots)}
              </div>
            </div>
            {renderLabelColumn(COMBINED_RIGHT_BUTTONS, combinedViewHotspots, "right")}
          </div>
        )}
      </div>

      <LayerPills selectedLayer={selectedLayer} onSelectLayer={onSelectLayer} />
    </div>
  );
}
