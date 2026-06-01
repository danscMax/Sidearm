// Heatmap execution-count badge (DOM `<span>`), shown on legend cells and
// photo-mode hotspots. The SVG-mode `<text>` variant stays local to the SVG
// button renderer (different element, not interchangeable).

import type { ControlId } from "../../lib/config";
import { heatIntensity } from "../../lib/mouse-visual";

interface HeatCountProps {
  controlId: ControlId;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
}

export function HeatCount({ controlId, executionCounts, heatmapEnabled }: HeatCountProps) {
  if (!heatmapEnabled || !executionCounts) return null;
  const count = executionCounts.get(controlId) ?? 0;
  if (count === 0) return null;
  const opacity = heatIntensity(count, executionCounts);
  return (
    <span
      className="heat-count"
      ref={(el) => {
        if (el) el.style.setProperty("--heat-opacity", String(opacity));
      }}
    >
      {count}x
    </span>
  );
}
