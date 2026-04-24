import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Action, Binding, ControlId, Layer } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { ACTION_CATEGORIES, layerCopy, topViewHotspots, sideViewHotspots, combinedViewHotspots } from "../lib/constants";
import { displayNameForControl, surfacePrimaryLabel } from "../lib/labels";
import { MouseVisualizationSvg } from "./MouseVisualizationSvg";

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

type ViewTab = "top" | "side" | "combined";

function actionLabel(entry: ControlSurfaceEntry): string {
  if (entry.action && entry.action.type !== "disabled" && entry.binding?.enabled) {
    const base = entry.action.pretty;
    const badge = triggerBadge(entry.binding.triggerMode);
    return badge ? `${base} ${badge}` : base;
  }
  return displayNameForControl(entry.control);
}

function triggerBadge(mode: string | undefined): string {
  switch (mode) {
    case "doublePress":
      return "· 2×";
    case "triplePress":
      return "· 3×";
    case "hold":
      return "· Hold";
    case "chord":
      return "· Chord";
    default:
      return "";
  }
}

function tooltipText(entry: ControlSurfaceEntry, unassignedLabel: string): string {
  const name = displayNameForControl(entry.control);
  if (!entry.action || entry.action.type === "disabled" || !entry.binding?.enabled) {
    return `${name}\n${unassignedLabel}`;
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
  const [hoveredId, setHoveredId] = useState<ControlId | null>(null);
  const [visualMode, setVisualMode] = useState<VisualMode>("photo");
  const [dragOverId, setDragOverId] = useState<ControlId | null>(null);

  function heatStyle(controlId: ControlId): React.CSSProperties | undefined {
    if (!heatmapEnabled || !executionCounts) return undefined;
    const count = executionCounts.get(controlId) ?? 0;
    if (count === 0) return undefined;
    return { backgroundColor: "rgba(159, 202, 105, 0.07)" };
  }

  function heatCount(controlId: ControlId): React.ReactNode {
    if (!heatmapEnabled || !executionCounts) return null;
    const count = executionCounts.get(controlId) ?? 0;
    if (count === 0) return null;
    const maxCount = Math.max(1, ...Array.from(executionCounts.values()));
    const intensity = Math.min(count / maxCount, 1);
    const opacity = 0.35 + intensity * 0.65;
    return (
      <span className="heat-count" style={{ opacity }}>
        {count}x
      </span>
    );
  }

  if (visualMode === "schematic") {
    return (
      <div className="mouse-visual-tabs">
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

  function handleRightClick(id: ControlId, e: React.MouseEvent) {
    e.preventDefault();
    const entry = entryMap.get(id);
    onContextMenu?.(id, entry?.binding ?? null, entry?.action ?? null, e.clientX, e.clientY);
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
          style={{ left: `${pos.left}%`, top: `${pos.top}%`, ...heatStyle(entry.control.id) }}
          onClick={(e) => handleClick(entry.control.id, e)}
          onDoubleClick={(e) => handleDblClick(entry.control.id, e)}
          onContextMenu={(e) => handleRightClick(entry.control.id, e)}
          onMouseEnter={() => setHoveredId(entry.control.id)}
          onMouseLeave={() => setHoveredId(null)}
          title={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
            entry.binding,
            entry.action,
          )}`}
          draggable={!!entry.binding && !!entry.action}
          onDragStart={(e) => {
            if (!entry.binding || !entry.action) { e.preventDefault(); return; }
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData("application/json", JSON.stringify({
              type: "binding", actionId: entry.action.id,
            }));
          }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDragEnter={(e) => { e.preventDefault(); setDragOverId(entry.control.id); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverId(null);
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/json")) as { type: string; actionId: string };
              if (data.type === "binding") onDropBinding?.(entry.control.id, data.actionId);
            } catch { /* ignore malformed data */ }
          }}
        >
          {pos.label}
          {heatCount(entry.control.id)}
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
          const isDragOver = dragOverId === controlId;
          const isDimmed = matchedControlIds != null && !matchedControlIds.has(controlId);
          const hasConflict = !!entry.binding && conflictBindingIds?.has(entry.binding.id);
          return (
            <button
              type="button"
              key={controlId}
              className={`btn-legend__cell${isSelected ? " btn-legend__cell--selected" : ""}${isHovered ? " btn-legend__cell--hovered" : ""}${isDragOver ? " mouse-visual__hotspot--dragover" : ""}${isDimmed ? " btn-legend__cell--dimmed" : ""}${hasConflict ? " btn-legend__cell--conflict" : ""}`}
              data-action-type={entry.action?.type ?? ""}
              data-tooltip={tooltipText(entry, t("visualization.unassigned"))}
              style={heatStyle(controlId)}
              onClick={(e) => handleClick(controlId, e)}
              onDoubleClick={(e) => handleDblClick(controlId, e)}
              onContextMenu={(e) => handleRightClick(controlId, e)}
              onMouseEnter={() => setHoveredId(controlId)}
              onMouseLeave={() => setHoveredId(null)}
              draggable={!!entry.binding && !!entry.action}
              onDragStart={(e) => {
                if (!entry.binding || !entry.action) { e.preventDefault(); return; }
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/json", JSON.stringify({
                  type: "binding", actionId: entry.action.id,
                }));
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDragEnter={(e) => { e.preventDefault(); setDragOverId(controlId); }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverId(null);
                try {
                  const data = JSON.parse(e.dataTransfer.getData("application/json")) as { type: string; actionId: string };
                  if (data.type === "binding") onDropBinding?.(controlId, data.actionId);
                } catch { /* ignore malformed data */ }
              }}
            >
              <span className="btn-legend__badge">{badge}</span>
              <span className="btn-legend__label">{actionLabel(entry)}</span>
              {heatCount(controlId)}
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
              const isDragOver = dragOverId === controlId;
              const isDimmed = matchedControlIds != null && !matchedControlIds.has(controlId);
              const hasConflict = !!entry.binding && conflictBindingIds?.has(entry.binding.id);
              return (
                <button
                  type="button"
                  key={controlId}
                  className={`btn-legend__cell${isSelected ? " btn-legend__cell--selected" : ""}${isHovered ? " btn-legend__cell--hovered" : ""}${isDragOver ? " mouse-visual__hotspot--dragover" : ""}${isDimmed ? " btn-legend__cell--dimmed" : ""}${hasConflict ? " btn-legend__cell--conflict" : ""}`}
                  data-action-type={entry.action?.type ?? ""}
                  style={heatStyle(controlId)}
                  onClick={(e) => handleClick(controlId, e)}
                  onDoubleClick={(e) => handleDblClick(controlId, e)}
                  onMouseEnter={() => setHoveredId(controlId)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={`${displayNameForControl(entry.control)} · ${surfacePrimaryLabel(
                    entry.binding,
                    entry.action,
                  )}`}
                  draggable={!!entry.binding && !!entry.action}
                  onDragStart={(e) => {
                    if (!entry.binding || !entry.action) { e.preventDefault(); return; }
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/json", JSON.stringify({
                      type: "binding", actionId: entry.action.id,
                    }));
                  }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                  onDragEnter={(e) => { e.preventDefault(); setDragOverId(controlId); }}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverId(null);
                    try {
                      const data = JSON.parse(e.dataTransfer.getData("application/json")) as { type: string; actionId: string };
                      if (data.type === "binding") onDropBinding?.(controlId, data.actionId);
                    } catch { /* ignore malformed data */ }
                  }}
                >
                  <span className="btn-legend__badge">{badge}</span>
                  <span className="btn-legend__label">{actionLabel(entry)}</span>
                  {heatCount(controlId)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  const layerIdx = layerCopy.findIndex((l) => l.value === selectedLayer);

  const viewTabs: { key: ViewTab; label: string }[] = [
    { key: "combined", label: t("visualization.tabAll") },
    { key: "top", label: t("visualization.tabTop") },
    { key: "side", label: t("visualization.tabSide") },
  ];
  const viewIdx = viewTabs.findIndex((t) => t.key === activeTab);

  return (
    <div className="mouse-visual-tabs">
      <div className="mouse-visual-tabs__nav">
        <div className="pill-track" style={{ "--pill-count": viewTabs.length } as React.CSSProperties}>
          {viewIdx >= 0 ? (
            <div
              className="pill-track__indicator"
              style={{ transform: `translateX(${viewIdx * 100}%)` }}
            />
          ) : null}
          {viewTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`pill-track__pill${tab.key === activeTab ? " pill-track__pill--active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
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

      <div className="mouse-visual-tabs__footer">
        <div className="pill-track pill-track--layer" style={{ "--pill-count": layerCopy.length } as React.CSSProperties}>
          {layerIdx >= 0 ? (
            <div
              className={`pill-track__indicator pill-track__indicator--${selectedLayer}`}
              style={{ transform: `translateX(${layerIdx * 100}%)` }}
            />
          ) : null}
          {layerCopy.map((layer) => (
            <button
              key={layer.value}
              type="button"
              className={`pill-track__pill${layer.value === selectedLayer ? " pill-track__pill--active" : ""}`}
              onClick={() => onSelectLayer(layer.value)}
            >
              {layer.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
