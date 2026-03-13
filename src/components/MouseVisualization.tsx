import { useState } from "react";
import type { Binding, ControlId, Layer } from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { ACTION_CATEGORIES, layerCopy } from "../lib/constants";
import { displayNameForControl, surfacePrimaryLabel } from "../lib/helpers";

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

/* ── Helpers ── */

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

/* ── Layout constants for the SVG illustration ── */

/** viewBox = "0 0 340 520" — top-down mouse schematic */
const VB_W = 340;
const VB_H = 520;

/** Top-panel button regions: id, label, SVG path, label-x, label-y */
type SvgButtonDef = {
  id: ControlId;
  label: string;
  path: string;
  lx: number;
  ly: number;
};

const TOP_BUTTONS: SvgButtonDef[] = [
  {
    id: "mouse_left",
    label: "ЛКМ",
    // Left click: left half of mouse top
    path: "M 80 4 C 55 4, 30 22, 22 60 L 22 200 L 168 200 L 168 4 Z",
    lx: 95,
    ly: 100,
  },
  {
    id: "mouse_right" as ControlId,
    label: "ПКМ",
    // Right click: right half of mouse top (not always intercepted, included for visual)
    path: "M 172 4 L 172 200 L 318 200 L 318 60 C 310 22, 285 4, 260 4 Z",
    lx: 245,
    ly: 100,
  },
  {
    id: "top_aux_01",
    label: "D+",
    // DPI up: small button left of wheel
    path: "M 128 48 L 128 82 L 155 82 L 155 48 Z",
    lx: 141,
    ly: 65,
  },
  {
    id: "top_aux_02",
    label: "D\u2212",
    // DPI down: small button left of wheel, below DPI up
    path: "M 128 90 L 128 124 L 155 124 L 155 90 Z",
    lx: 141,
    ly: 107,
  },
  {
    id: "wheel_up",
    label: "\u25B2",
    // Scroll up: top portion of scroll wheel
    path: "M 158 38 Q 170 32, 182 38 L 182 72 L 158 72 Z",
    lx: 170,
    ly: 56,
  },
  {
    id: "wheel_click",
    label: "\u25CF",
    // Wheel click: middle of scroll wheel
    path: "M 158 76 L 182 76 L 182 118 L 158 118 Z",
    lx: 170,
    ly: 97,
  },
  {
    id: "wheel_down",
    label: "\u25BC",
    // Scroll down: bottom portion of scroll wheel
    path: "M 158 122 L 182 122 L 182 156 Q 170 162, 158 156 Z",
    lx: 170,
    ly: 140,
  },
  {
    id: "mouse_4",
    label: "\u2190",
    // Back button: small button left side near top
    path: "M 26 168 L 26 194 L 60 194 L 60 168 Z",
    lx: 43,
    ly: 181,
  },
  {
    id: "mouse_5",
    label: "\u2192",
    // Forward button: small button right side near top
    path: "M 280 168 L 280 194 L 314 194 L 314 168 Z",
    lx: 297,
    ly: 181,
  },
  {
    id: "hypershift_button",
    label: "HS",
    // Hypershift: small button right of wheel area
    path: "M 186 48 L 186 82 L 213 82 L 213 48 Z",
    lx: 199,
    ly: 65,
  },
];

/**
 * Thumb grid: 4 columns x 3 rows.
 * Physical layout (user perspective looking at bottom of mouse):
 *   Col 1  Col 2  Col 3  Col 4     (front to back)
 *   btn 3  btn 6  btn 9  btn 12    row 3 (top)
 *   btn 2  btn 5  btn 8  btn 11    row 2 (middle)
 *   btn 1  btn 4  btn 7  btn 10    row 1 (bottom)
 *
 * In SVG the grid sits on the left-side panel area.
 */
const THUMB_GRID_ORIGIN_X = 42;
const THUMB_GRID_ORIGIN_Y = 272;
const THUMB_CELL_W = 54;
const THUMB_CELL_H = 42;
const THUMB_GAP = 6;

/** Grid position [col, row] where col 0..3 = front..back, row 0..2 = bottom..top */
const THUMB_POSITIONS: Array<{ id: ControlId; col: number; row: number; num: number }> = [
  { id: "thumb_01", col: 0, row: 0, num: 1 },
  { id: "thumb_02", col: 0, row: 1, num: 2 },
  { id: "thumb_03", col: 0, row: 2, num: 3 },
  { id: "thumb_04", col: 1, row: 0, num: 4 },
  { id: "thumb_05", col: 1, row: 1, num: 5 },
  { id: "thumb_06", col: 1, row: 2, num: 6 },
  { id: "thumb_07", col: 2, row: 0, num: 7 },
  { id: "thumb_08", col: 2, row: 1, num: 8 },
  { id: "thumb_09", col: 2, row: 2, num: 9 },
  { id: "thumb_10", col: 3, row: 0, num: 10 },
  { id: "thumb_11", col: 3, row: 1, num: 11 },
  { id: "thumb_12", col: 3, row: 2, num: 12 },
];

function thumbRect(col: number, row: number) {
  // Row 0 = bottom, row 2 = top => invert Y for SVG
  const invertedRow = 2 - row;
  const x = THUMB_GRID_ORIGIN_X + col * (THUMB_CELL_W + THUMB_GAP);
  const y = THUMB_GRID_ORIGIN_Y + invertedRow * (THUMB_CELL_H + THUMB_GAP);
  return { x, y, w: THUMB_CELL_W, h: THUMB_CELL_H };
}

/* ── Color helpers ── */

const ACTION_TYPE_COLORS: Partial<Record<string, { border: string; fill: string }>> = {
  shortcut:      { border: "rgba(143,211,232,0.6)", fill: "rgba(143,211,232,0.15)" },
  mouseAction:   { border: "rgba(183,226,107,0.6)", fill: "rgba(183,226,107,0.15)" },
  textSnippet:   { border: "rgba(231,196,111,0.6)", fill: "rgba(231,196,111,0.15)" },
  sequence:      { border: "rgba(196,153,255,0.6)", fill: "rgba(196,153,255,0.15)" },
  launch:        { border: "rgba(255,153,102,0.6)", fill: "rgba(255,153,102,0.15)" },
  mediaKey:      { border: "rgba(255,153,204,0.6)", fill: "rgba(255,153,204,0.15)" },
  profileSwitch: { border: "rgba(153,204,255,0.6)", fill: "rgba(153,204,255,0.15)" },
  menu:          { border: "rgba(204,204,153,0.6)", fill: "rgba(204,204,153,0.15)" },
  disabled:      { border: "rgba(160,160,160,0.4)", fill: "rgba(160,160,160,0.1)" },
};

function buttonColors(
  entry: ControlSurfaceEntry | undefined,
  isSelected: boolean,
  isHovered: boolean,
): { stroke: string; fill: string; strokeDasharray?: string } {
  if (isSelected) {
    return {
      stroke: "var(--layer-accent, var(--c-accent))",
      fill: "rgba(var(--layer-rgb, 159,202,105), 0.25)",
    };
  }
  if (isHovered) {
    return {
      stroke: "rgba(var(--layer-border-rgb, 180,226,125), 1)",
      fill: "rgba(var(--layer-rgb, 159,202,105), 0.35)",
    };
  }
  if (entry?.binding?.enabled && entry.action && entry.action.type !== "disabled") {
    const typeColor = ACTION_TYPE_COLORS[entry.action.type];
    if (typeColor) {
      return { stroke: typeColor.border, fill: typeColor.fill };
    }
    return {
      stroke: "rgba(var(--layer-rgb, 159,202,105), 0.6)",
      fill: "rgba(var(--layer-rgb, 159,202,105), 0.2)",
    };
  }
  // Unassigned
  return {
    stroke: "rgba(200,210,195,0.25)",
    fill: "rgba(12,20,14,0.45)",
    strokeDasharray: "4 3",
  };
}

/* ── Legend column button lists (kept from old component for label panels) ── */

const TOP_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
];

const TOP_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "mouse_5", "wheel_down",
];

const COMBINED_LEFT_BUTTONS: ControlId[] = [
  "mouse_left", "top_aux_01", "top_aux_02", "mouse_4",
  "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
];

const COMBINED_RIGHT_BUTTONS: ControlId[] = [
  "hypershift_button", "wheel_up", "wheel_click", "wheel_down", "mouse_5",
  "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
];

const SIDE_LEGEND_GRID: ControlId[][] = [
  ["thumb_03", "thumb_06", "thumb_09", "thumb_12"],
  ["thumb_02", "thumb_05", "thumb_08", "thumb_11"],
  ["thumb_01", "thumb_04", "thumb_07", "thumb_10"],
];

/** Short badge labels used inside hotspot labels in the legend. */
const HOTSPOT_LABELS: Partial<Record<ControlId, string>> = {
  mouse_left: "ЛКМ",
  mouse_right: "ПКМ",
  top_aux_01: "D+",
  top_aux_02: "D\u2212",
  mouse_4: "\u2190",
  mouse_5: "\u2192",
  wheel_up: "\u25B2",
  wheel_click: "\u25CF",
  wheel_down: "\u25BC",
  hypershift_button: "HS",
  thumb_01: "1", thumb_02: "2", thumb_03: "3",
  thumb_04: "4", thumb_05: "5", thumb_06: "6",
  thumb_07: "7", thumb_08: "8", thumb_09: "9",
  thumb_10: "10", thumb_11: "11", thumb_12: "12",
};

/* ── Component ── */

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

  /* ── SVG: Mouse body outline ── */

  function renderMouseBody() {
    return (
      <>
        {/* Outer body silhouette */}
        <path
          d="
            M 80 4
            C 55 4, 22 22, 22 60
            L 14 220
            Q 8 280, 10 330
            Q 12 420, 52 470
            Q 100 515, 170 518
            Q 240 515, 288 470
            Q 328 420, 330 330
            Q 332 280, 326 220
            L 318 60
            C 318 22, 285 4, 260 4
            Z
          "
          fill="url(#bodyGradient)"
          stroke="rgba(200,210,195,0.15)"
          strokeWidth="1.5"
        />
        {/* Top panel divider — separates top buttons from body */}
        <line x1="22" y1="200" x2="318" y2="200" stroke="rgba(200,210,195,0.12)" strokeWidth="1" />
        {/* Center ridge (LMB/RMB divider) */}
        <line x1="170" y1="4" x2="170" y2="200" stroke="rgba(200,210,195,0.08)" strokeWidth="1" />
        {/* Wheel well */}
        <rect
          x="155" y="30" width="30" height="138" rx="15"
          fill="rgba(8,14,10,0.6)"
          stroke="rgba(200,210,195,0.12)"
          strokeWidth="1"
        />
        {/* Thumb grid panel outline — left side */}
        <rect
          x={THUMB_GRID_ORIGIN_X - 8}
          y={THUMB_GRID_ORIGIN_Y - 10}
          width={4 * THUMB_CELL_W + 3 * THUMB_GAP + 16}
          height={3 * THUMB_CELL_H + 2 * THUMB_GAP + 20}
          rx="8"
          fill="rgba(8,14,10,0.3)"
          stroke="rgba(200,210,195,0.08)"
          strokeWidth="1"
        />
      </>
    );
  }

  /* ── SVG: Interactive button regions ── */

  function renderSvgButton(
    id: ControlId,
    shape: React.ReactNode,
    labelX: number,
    labelY: number,
    label: string,
    fontSize?: number,
  ) {
    const entry = entryMap.get(id);
    const isSelected = entry?.isSelected || multiSelectedControlIds.has(id);
    const isHovered = hoveredId === id;
    const colors = buttonColors(entry, isSelected, isHovered);
    const title = entry
      ? `${displayNameForControl(entry.control)} \u00B7 ${surfacePrimaryLabel(entry.binding, entry.action)}`
      : id;
    const fs = fontSize ?? 10;
    const hasGlow = isSelected || isHovered;

    return (
      <g
        key={id}
        className="mouse-svg__btn"
        data-control-id={id}
        style={{ cursor: "pointer" }}
        onClick={(e) => handleClick(id, e)}
        onDoubleClick={(e) => handleDblClick(id, e)}
        onMouseEnter={() => setHoveredId(id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        <title>{title}</title>
        <g
          style={{
            transition: "filter 180ms ease",
            filter: hasGlow
              ? `drop-shadow(0 0 ${isSelected ? "10px" : "6px"} rgba(var(--layer-rgb, 159,202,105), ${isSelected ? "0.5" : "0.4"}))`
              : "none",
          }}
        >
          {/* Hit area / visible shape */}
          <g
            fill={colors.fill}
            stroke={colors.stroke}
            strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1.5}
            strokeDasharray={colors.strokeDasharray}
          >
            {shape}
          </g>
        </g>
        {/* Label */}
        <text
          x={labelX}
          y={labelY}
          textAnchor="middle"
          dominantBaseline="central"
          fill={isSelected || isHovered ? "#fff" : "rgba(220,230,210,0.8)"}
          fontSize={fs}
          fontWeight={700}
          fontFamily="'Segoe UI Variable Display', 'Bahnschrift', sans-serif"
          pointerEvents="none"
          style={{ userSelect: "none" }}
        >
          {label}
        </text>
      </g>
    );
  }

  function renderTopButtons() {
    return TOP_BUTTONS.map((btn) =>
      renderSvgButton(
        btn.id,
        <path d={btn.path} rx={4} />,
        btn.lx,
        btn.ly,
        btn.label,
        btn.id === "mouse_left" || btn.id === ("mouse_right" as ControlId) ? 14 : 10,
      ),
    );
  }

  function renderThumbGrid() {
    return THUMB_POSITIONS.map((thumb) => {
      const r = thumbRect(thumb.col, thumb.row);
      return renderSvgButton(
        thumb.id,
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={5} />,
        r.x + r.w / 2,
        r.y + r.h / 2,
        String(thumb.num),
        12,
      );
    });
  }

  /* ── SVG: Full illustration ── */

  function renderMouseSvg(showTop: boolean, showThumb: boolean) {
    return (
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%", display: "block" }}
        role="img"
        aria-label="Razer Naga V2 HyperSpeed \u2014 схематический вид"
      >
        <defs>
          <linearGradient id="bodyGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(30,42,35,0.95)" />
            <stop offset="50%" stopColor="rgba(20,30,24,0.98)" />
            <stop offset="100%" stopColor="rgba(14,22,17,0.95)" />
          </linearGradient>
          <linearGradient id="wheelGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(60,80,65,0.5)" />
            <stop offset="100%" stopColor="rgba(30,40,33,0.5)" />
          </linearGradient>
        </defs>

        {renderMouseBody()}
        {showTop && renderTopButtons()}
        {showThumb && renderThumbGrid()}

        {/* "NAGA" tiny text branding area */}
        <text
          x={170}
          y={230}
          textAnchor="middle"
          dominantBaseline="central"
          fill="rgba(200,210,195,0.12)"
          fontSize={11}
          fontWeight={800}
          letterSpacing="0.15em"
          fontFamily="'Segoe UI Variable Display', 'Bahnschrift', sans-serif"
          pointerEvents="none"
          style={{ userSelect: "none" }}
        >
          NAGA V2
        </text>
      </svg>
    );
  }

  /* ── Legend columns (reused from the original design) ── */

  function renderLabelColumn(
    controlIds: ControlId[],
    side: "left" | "right",
  ) {
    return (
      <div className={`mouse-top-labels mouse-top-labels--${side}`}>
        {controlIds.map((controlId) => {
          const entry = entryMap.get(controlId);
          if (!entry) return null;
          const badge = HOTSPOT_LABELS[controlId] ?? controlId;
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

  function renderSideLegendGrid() {
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
              const badge = HOTSPOT_LABELS[controlId] ?? controlId;
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
                  title={`${displayNameForControl(entry.control)} \u00B7 ${surfacePrimaryLabel(
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

  /* ── Layer toggle ── */

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

  /* ── Render ── */

  return (
    <div className="mouse-visual-tabs">
      <div className="mouse-visual-tabs__nav">
        {layerToggle}
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

      <div className="mouse-visual-tabs__content" key={activeTab}>
        {activeTab === "top" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(TOP_LEFT_BUTTONS, "left")}
            <div className="mouse-visual mouse-visual--svg-top">
              {renderMouseSvg(true, false)}
            </div>
            {renderLabelColumn(TOP_RIGHT_BUTTONS, "right")}
          </div>
        )}
        {activeTab === "side" && (
          <div className="mouse-view-panel">
            <div className="mouse-visual mouse-visual--svg-side">
              {renderMouseSvg(false, true)}
            </div>
            {renderSideLegendGrid()}
          </div>
        )}
        {activeTab === "combined" && (
          <div className="mouse-top-layout">
            {renderLabelColumn(COMBINED_LEFT_BUTTONS, "left")}
            <div className="mouse-visual mouse-visual--svg-combined">
              {renderMouseSvg(true, true)}
            </div>
            {renderLabelColumn(COMBINED_RIGHT_BUTTONS, "right")}
          </div>
        )}
      </div>
      <div className="mouse-visual-tabs__footer">
        {layerToggle}
      </div>
    </div>
  );
}
