import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlId } from "../lib/config";
import { sideViewHotspots } from "../lib/constants";
import { deviceControlId, layoutControlId, type DeviceLayout } from "../lib/devices";
import { buildHotspotTooltip, resolveControlBadge } from "../lib/labels";
import { MouseVisualizationSvg } from "./MouseVisualizationSvg";
import { NagaV3Bottom } from "./NagaV3Bottom";
import {
  actionLabel,
  type MouseVisualizationProps,
  type TriggerBadgeLabels,
  type ViewTab,
} from "../lib/mouse-visual";
import { useControlInteractions } from "../hooks/useControlInteractions";
import { LabelColumn } from "./mouse-visual/LabelColumn";
import { LegendCell } from "./mouse-visual/LegendCell";
import { LayerPills } from "./mouse-visual/LayerPills";
import { ViewTabPills } from "./mouse-visual/ViewTabPills";

type VisualMode = "photo" | "schematic";

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
  layers,
  onContextMenu,
  executionCounts,
  executionHistory,
  throttledControlIds,
  heatmapEnabled,
  onDropBinding,
  layout,
}: MouseVisualizationProps & { layout: DeviceLayout }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>("combined");
  const [visualMode, setVisualMode] = useState<VisualMode>("photo");
  const view = layout.views.includes(activeTab) ? activeTab : "combined";
  const toDevice = (id: ControlId) => deviceControlId(layout, id);
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

  if (visualMode === "schematic" && layout.schematic) {
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
          matchedControlIds={matchedControlIds}
          conflictBindingIds={conflictBindingIds}
          onSelectControl={onSelectControl}
          onToggleMultiSelect={onToggleMultiSelect}
          onOpenActionPicker={onOpenActionPicker}
          onSelectLayer={onSelectLayer}
          layers={layers}
          onContextMenu={onContextMenu}
          executionCounts={executionCounts}
          executionHistory={executionHistory}
          throttledControlIds={throttledControlIds}
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
      const pos = hotspots[layoutControlId(entry.control.id)];
      if (!pos) return null;

      const isAssigned = entry.isHypershiftTrigger || (entry.binding && entry.binding.enabled && entry.action && entry.action.type !== "disabled");
      const actionType = entry.action?.type;
      const assignedClass = isAssigned
        ? ` mouse-visual__hotspot--assigned${actionType && !entry.isHypershiftTrigger ? ` mouse-visual__hotspot--type-${actionType}` : ""}`
        : " mouse-visual__hotspot--unassigned";
      const isSelected = entry.isSelected || multiSelectedControlIds.has(entry.control.id);
      const isHovered = hoveredId === entry.control.id;

      const isDragOver = dragOverId === entry.control.id;
      const isDimmed =
        matchedControlIds != null && !matchedControlIds.has(entry.control.id);
      const hasConflict =
        !!entry.binding && conflictBindingIds?.has(entry.binding.id);
      // Heatmap on the photo is conveyed by the background tint (applyHeatBg);
      // the exact press count rides along in the structured tooltip instead of
      // an overflowing in-circle badge.
      const totalCount = executionCounts?.get(entry.control.id) ?? 0;
      const isThrottled = throttledControlIds?.has(entry.control.id) ?? false;
      const tooltip = buildHotspotTooltip(entry, selectedLayer, executionHistory?.get(entry.control.id), totalCount);

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
          }${isThrottled ? " mouse-visual__hotspot--throttled" : ""}`}
          ref={(el) => {
            if (el) {
              el.style.setProperty("--hotspot-left", `${pos.left}%`);
              el.style.setProperty("--hotspot-top", `${pos.top}%`);
            }
            applyHeatBg(el, entry.control.id);
          }}
          title={tooltip}
          aria-label={tooltip}
          draggable={!!entry.binding && !!entry.action}
          {...getInteractionProps(entry.control.id)}
        >
          {resolveControlBadge(pos.label)}
          {entry.isHypershiftTrigger && (entry.isHypershift2Trigger || !layout.firmwareTrigger) && (
            <span className="mouse-visual__assignment" aria-hidden="true">
              {t(entry.isHypershift2Trigger ? "visualization.hypershift2Badge" : "visualization.hypershiftBadge")}
            </span>
          )}
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
        controlIds={controlIds.map(toDevice)}
        side={side}
        interaction={interaction}
        multiSelectedControlIds={multiSelectedControlIds}
        badgeFor={(id) => resolveControlBadge(hotspots[layoutControlId(id)]?.label ?? layoutControlId(id))}
        actionLabelFor={(entry) => layout.firmwareTrigger && entry.isHypershiftTrigger && !entry.isHypershift2Trigger
          ? t("visualization.firmwareHypershift")
          : actionLabel(entry, { triggerLabels })}
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
            {row.map((layoutId) => {
              const controlId = toDevice(layoutId);
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
                  badge={resolveControlBadge(hotspots[layoutId]?.label ?? layoutId)}
                  label={actionLabel(entry, { triggerLabels })}
                  tooltip={buildHotspotTooltip(
                    entry,
                    selectedLayer,
                    executionHistory?.get(controlId),
                    executionCounts?.get(controlId) ?? 0,
                  )}
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

  const { top, combined, bottom } = layout;
  return (
    <div className={layout.bottom ? "mouse-visual-tabs naga-v3" : "mouse-visual-tabs"} data-layer={selectedLayer}>
      <div className="mouse-visual-tabs__nav">
        <ViewTabPills activeTab={view} onSelect={setActiveTab} views={layout.views} labels={layout.tabLabels} />
        {layout.schematic && <button
          type="button"
          className="view-mode-toggle view-mode-toggle--icon"
          onClick={() => setVisualMode("schematic")}
          title={t("visualization.switchSchematic")}
          aria-label={t("visualization.switchSchematic")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>}
      </div>

      <div className="mouse-visual-tabs__content">
        {view === "top" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(top.left, top.hotspots, "left")}
            <div className="mouse-visual mouse-visual--top">
              <img
                className="mouse-visual__img"
                src="/assets/naga-top.webp"
                alt={t("visualization.photoAltTop")}
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(top.hotspots)}
              </div>
            </div>
            {renderLabelColumn(top.right, top.hotspots, "right")}
          </div>
        )}
        {view === "side" && (
          <div className="mouse-view-panel">
            <div className="mouse-visual mouse-visual--side">
              <img
                className="mouse-visual__img"
                src="/assets/naga-side.webp"
                alt={t("visualization.photoAltSide")}
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(sideViewHotspots)}
              </div>
            </div>
            {layout.sideNote && <span className="panel__muted">{t(layout.sideNote)}</span>}
            {renderSideLegendGrid(sideViewHotspots)}
          </div>
        )}
        {view === "combined" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(combined.left, combined.hotspots, "left")}
            <div className="mouse-visual mouse-visual--combined">
              <img
                className="mouse-visual__img"
                src="/assets/naga-combined.webp"
                alt={t("visualization.photoAltCombined")}
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(combined.hotspots)}
              </div>
            </div>
            {renderLabelColumn(combined.right, combined.hotspots, "right")}
          </div>
        )}
        {view === "bottom" && bottom && (
          <div className="mouse-view-panel">
            <div className="mouse-visual naga-v3__bottom">
              <NagaV3Bottom />
              <div className="mouse-visual__overlay">{renderHotspotButtons(bottom.hotspots)}</div>
            </div>
            {renderLabelColumn(bottom.left, bottom.hotspots, "left")}
          </div>
        )}
      </div>

      <LayerPills selectedLayer={selectedLayer} onSelectLayer={onSelectLayer} layers={layers} />
    </div>
  );
}
