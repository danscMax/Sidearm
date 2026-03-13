import { useState } from "react";
import type { Binding, ControlId, Layer } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { ACTION_CATEGORIES, layerCopy, topViewHotspots, sideViewHotspots, combinedViewHotspots } from "../lib/constants";
import { displayNameForControl, surfacePrimaryLabel } from "../lib/helpers";
import { MouseVisualizationSvg } from "./MouseVisualizationSvg";

type VisualMode = "photo" | "schematic";

interface MouseVisualizationProps {
  entries: ControlSurfaceEntry[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectControl: (id: ControlId) => void;
  onToggleMultiSelect: (id: ControlId) => void;
  onOpenActionPicker: (id: ControlId, binding: Binding | null) => void;
  onSelectLayer: (layer: Layer) => void;
}

type ViewTab = "top" | "side" | "combined";

function actionLabel(entry: ControlSurfaceEntry): string {
  if (entry.action && entry.action.type !== "disabled" && entry.binding?.enabled) {
    return entry.action.pretty;
  }
  return displayNameForControl(entry.control);
}

function tooltipText(entry: ControlSurfaceEntry): string {
  const name = displayNameForControl(entry.control);
  if (!entry.action || entry.action.type === "disabled" || !entry.binding?.enabled) {
    return `${name}\nНе назначено`;
  }
  const cat = ACTION_CATEGORIES.find((c) => c.actionType === entry.action!.type);
  return `${name}\n${cat?.label ?? ""}: ${entry.action.pretty}`;
}

/** Top view: left-side buttons (physical left half of mouse). */
const TOP_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
];

/** Top view: right-side buttons (physical right half / wheel area). */
const TOP_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "mouse_5", "wheel_down",
];

/** Combined view: left labels (thumb 1-6 + DPI/LMB/M4). */
const COMBINED_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
  "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
];

/** Combined view: right labels (wheel/HS/M5 + thumb 7-12). */
const COMBINED_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "wheel_down", "mouse_5",
  "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
];

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
  onSelectControl,
  onToggleMultiSelect,
  onOpenActionPicker,
  onSelectLayer,
}: MouseVisualizationProps) {
  const [activeTab, setActiveTab] = useState<ViewTab>("combined");
  const [hoveredId, setHoveredId] = useState<ControlId | null>(null);
  const [visualMode, setVisualMode] = useState<VisualMode>("photo");

  if (visualMode === "schematic") {
    return (
      <div className="mouse-visual-tabs">
        <div className="mouse-visual-tabs__nav">
          <button
            type="button"
            className="view-mode-toggle"
            onClick={() => setVisualMode("photo")}
            title="Переключить на фото"
          >
            Схема
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
        />
      </div>
    );
  }

  const entryMap = new Map(entries.map((e) => [e.control.id, e]));

  function handleClick(id: ControlId, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      onToggleMultiSelect(id);
    } else {
      onSelectControl(id);
    }
  }

  function handleDblClick(id: ControlId, e: React.MouseEvent) {
    e.preventDefault();
    onOpenActionPicker(id, entryMap.get(id)?.binding ?? null);
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

      return (
        <button
          type="button"
          key={entry.control.id}
          className={`mouse-visual__hotspot${
            isSelected ? " mouse-visual__hotspot--selected" : assignedClass
          }${pos.size === "sm" ? " mouse-visual__hotspot--sm" : ""}${
            pos.size === "lg" ? " mouse-visual__hotspot--lg" : ""
          }${isHovered ? " mouse-visual__hotspot--hovered" : ""}`}
          style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
          onClick={(e) => handleClick(entry.control.id, e)}
          onDoubleClick={(e) => handleDblClick(entry.control.id, e)}
          onMouseEnter={() => setHoveredId(entry.control.id)}
          onMouseLeave={() => setHoveredId(null)}
          title={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
            entry.binding,
            entry.action,
          )}`}
        >
          {pos.label}
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
      <div className={`mouse-top-labels mouse-top-labels--${side}`}>
        {controlIds.map((controlId) => {
          const entry = entryMap.get(controlId);
          if (!entry) return null;
          const badge = hotspots[controlId]?.label ?? controlId;
          const isSelected = entry.isSelected || multiSelectedControlIds.has(controlId);
          const isHovered = hoveredId === controlId;
          return (
            <button
              type="button"
              key={controlId}
              className={`btn-legend__cell${isSelected ? " btn-legend__cell--selected" : ""}${isHovered ? " btn-legend__cell--hovered" : ""}`}
              data-action-type={entry.action?.type ?? ""}
              data-tooltip={tooltipText(entry)}
              onClick={(e) => handleClick(controlId, e)}
              onDoubleClick={(e) => handleDblClick(controlId, e)}
              onMouseEnter={() => setHoveredId(controlId)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <span className="btn-legend__badge">{badge}</span>
              <span className="btn-legend__label">{actionLabel(entry)}</span>
            </button>
          );
        })}
      </div>
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
            style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}
          >
            {row.map((controlId) => {
              const entry = entryMap.get(controlId);
              if (!entry) return null;
              const badge = hotspots[controlId]?.label ?? controlId;
              const isSelected = entry.isSelected || multiSelectedControlIds.has(controlId);
              const isHovered = hoveredId === controlId;
              return (
                <button
                  type="button"
                  key={controlId}
                  className={`btn-legend__cell${isSelected ? " btn-legend__cell--selected" : ""}${isHovered ? " btn-legend__cell--hovered" : ""}`}
                  data-action-type={entry.action?.type ?? ""}
                  onClick={(e) => handleClick(controlId, e)}
                  onDoubleClick={(e) => handleDblClick(controlId, e)}
                  onMouseEnter={() => setHoveredId(controlId)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
                    entry.binding,
                    entry.action,
                  )}`}
                >
                  <span className="btn-legend__badge">{badge}</span>
                  <span className="btn-legend__label">{actionLabel(entry)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  const layerToggle = (
    <div className="layer-toggle">
      {layerCopy.map((layer) => (
        <button
          key={layer.value}
          type="button"
          className={`layer-toggle__btn layer-toggle__btn--${layer.value}${selectedLayer === layer.value ? " layer-toggle__btn--active" : ""}`}
          onClick={() => onSelectLayer(layer.value)}
        >
          {layer.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="mouse-visual-tabs">
      <div className="mouse-visual-tabs__nav">
        {layerToggle}
        <button
          type="button"
          className="view-mode-toggle"
          onClick={() => setVisualMode("schematic")}
          title="Переключить на схему"
        >
          Фото
        </button>
        <div className="view-tabs">
          <button
            type="button"
            className={`mouse-visual-tabs__btn${activeTab === "combined" ? " mouse-visual-tabs__btn--active" : ""}`}
            onClick={() => setActiveTab("combined")}
          >
            Все кнопки
          </button>
          <button
            type="button"
            className={`mouse-visual-tabs__btn${activeTab === "top" ? " mouse-visual-tabs__btn--active" : ""}`}
            onClick={() => setActiveTab("top")}
          >
            Верхняя панель
          </button>
          <button
            type="button"
            className={`mouse-visual-tabs__btn${activeTab === "side" ? " mouse-visual-tabs__btn--active" : ""}`}
            onClick={() => setActiveTab("side")}
          >
            Боковая клавиатура
          </button>
        </div>
      </div>

      <div className="mouse-visual-tabs__content">
        {activeTab === "top" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(TOP_LEFT_BUTTONS, topViewHotspots, "left")}
            <div className="mouse-visual mouse-visual--top">
              <img
                className="mouse-visual__img"
                src="/assets/naga-top.png"
                alt="Razer Naga V2 HyperSpeed — вид сверху"
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
                alt="Razer Naga V2 HyperSpeed — боковая клавиатура"
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
                alt="Razer Naga V2 HyperSpeed — все кнопки"
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
      <div className="mouse-visual-tabs__footer">
        {layerToggle}
      </div>
    </div>
  );
}
