import { nagaLayoutControlId } from "../lib/onboard-mapping";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlId } from "../lib/config";
import { topViewHotspots, sideViewHotspots, combinedViewHotspots } from "../lib/constants";
import { nagaV3TopHotspots, nagaV3CombinedHotspots } from "../lib/constants/hotspots";
import { buildHotspotTooltip, resolveControlBadge } from "../lib/labels";
import { MouseVisualizationSvg } from "./MouseVisualizationSvg";
import { NagaV3Bottom } from "./NagaV3Bottom";
import {
  actionLabel,
  COMBINED_LEFT_BUTTONS,
  COMBINED_RIGHT_BUTTONS,
  type MouseVisualizationProps,
  TOP_LEFT_BUTTONS,
  TOP_RIGHT_BUTTONS,
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
const BOTTOM_HOTSPOTS = { top_special_03: { left: 48.33, top: 64.29, label: "↓" } };

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
  executionHistory,
  throttledControlIds,
  heatmapEnabled,
  onDropBinding,
}: MouseVisualizationProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>("combined");
  const [visualMode, setVisualMode] = useState<VisualMode>("photo");
  const nagaV3 = entries.some((entry) => entry.control.defaultName === "control.name.v3ScrollMode");
  const view = !nagaV3 && activeTab === "bottom" ? "combined" : activeTab;
  const topHotspots = nagaV3 ? nagaV3TopHotspots : topViewHotspots;
  const combinedHotspots = nagaV3 ? nagaV3CombinedHotspots : combinedViewHotspots;
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

  if (visualMode === "schematic" && !nagaV3) {
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
      const pos = hotspots[nagaLayoutControlId(entry.control.id)];
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
          {entry.isHypershiftTrigger && pos.label !== "HS" && <span className="mouse-visual__assignment" aria-hidden="true">{t("visualization.hypershiftBadge")}</span>}
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
        controlIds={nagaV3 ? controlIds.map((id) => 'v3_' + id) : controlIds}
        side={side}
        interaction={interaction}
        multiSelectedControlIds={multiSelectedControlIds}
        badgeFor={(id) => resolveControlBadge(hotspots[nagaLayoutControlId(id)]?.label ?? nagaLayoutControlId(id))}
        actionLabelFor={(entry) => nagaV3 && entry.isHypershiftTrigger
          ? t("control.name.v3Ring")
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
              const controlId = nagaV3 ? 'v3_' + layoutId : layoutId;
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

  const topLeft = nagaV3 ? ["mouse_left", "top_aux_01", "top_aux_02", "wheel_left", "top_special_01"] : TOP_LEFT_BUTTONS;
  const topRight = nagaV3 ? ["mouse_right", "wheel_up", "wheel_click", "wheel_down", "wheel_right", "hypershift_button", "top_special_02"] : TOP_RIGHT_BUTTONS;
  const combinedLeft = nagaV3 ? [...topLeft, ...COMBINED_LEFT_BUTTONS.filter((id) => id.startsWith("thumb_"))] : COMBINED_LEFT_BUTTONS;
  const combinedRight = nagaV3 ? [...topRight, ...COMBINED_RIGHT_BUTTONS.filter((id) => id.startsWith("thumb_"))] : COMBINED_RIGHT_BUTTONS;
  return (
    <div className={nagaV3 ? "mouse-visual-tabs naga-v3" : "mouse-visual-tabs"} data-layer={selectedLayer}>
      <div className="mouse-visual-tabs__nav">
        <ViewTabPills activeTab={view} onSelect={setActiveTab} showBottom={nagaV3} />
        {!nagaV3 && <button
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
            {renderLabelColumn(topLeft, topHotspots, "left")}
            <div className="mouse-visual mouse-visual--top">
              <img
                className="mouse-visual__img"
                src="/assets/naga-top.webp"
                alt={t("visualization.photoAltTop")}
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(topHotspots)}
              </div>
            </div>
            {renderLabelColumn(topRight, topHotspots, "right")}
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
            {nagaV3 && <span className="panel__muted">{t("visualization.v3Plate12")}</span>}
            {renderSideLegendGrid(sideViewHotspots)}
          </div>
        )}
        {view === "combined" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(combinedLeft, combinedHotspots, "left")}
            <div className="mouse-visual mouse-visual--combined">
              <img
                className="mouse-visual__img"
                src="/assets/naga-combined.webp"
                alt={t("visualization.photoAltCombined")}
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="mouse-visual__overlay">
                {renderHotspotButtons(combinedHotspots)}
              </div>
            </div>
            {renderLabelColumn(combinedRight, combinedHotspots, "right")}
          </div>
        )}
        {view === "bottom" && (
          <div className="mouse-view-panel">
            <div className="mouse-visual naga-v3__bottom">
              <NagaV3Bottom />
              <div className="mouse-visual__overlay">{renderHotspotButtons(BOTTOM_HOTSPOTS)}</div>
            </div>
            {renderLabelColumn(["top_special_03"], BOTTOM_HOTSPOTS, "left")}
          </div>
        )}
      </div>

      <LayerPills selectedLayer={selectedLayer} onSelectLayer={onSelectLayer} />
    </div>
  );
}
