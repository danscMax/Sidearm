// A vertical column of button-legend cells, shared by the photo and schematic
// visualizers. Differences between the two modes are passed in:
//   • badgeFor       — badge source (hotspot map vs HOTSPOT_LABELS)
//   • actionLabelFor — with/without the trigger-mode badge
//   • matchedControlIds / conflictBindingIds — photo mode only (dimmed/conflict)

import type { ControlId } from "../../lib/config";
import type { ControlSurfaceEntry } from "../../lib/constants";
import type { ControlInteractions } from "../../hooks/useControlInteractions";
import { tooltipText } from "../../lib/mouse-visual";
import { LegendCell } from "./LegendCell";

interface LabelColumnProps {
  controlIds: ControlId[];
  side: "left" | "right";
  interaction: ControlInteractions;
  multiSelectedControlIds: Set<ControlId>;
  badgeFor: (id: ControlId) => string;
  actionLabelFor: (entry: ControlSurfaceEntry) => string;
  unassignedLabel: string;
  executionCounts?: Map<string, number>;
  heatmapEnabled?: boolean;
  /** Photo mode only: controls outside the set are dimmed. */
  matchedControlIds?: Set<ControlId> | null;
  /** Photo mode only: bindings in the set are flagged as conflicting. */
  conflictBindingIds?: Set<string>;
}

export function LabelColumn({
  controlIds,
  side,
  interaction,
  multiSelectedControlIds,
  badgeFor,
  actionLabelFor,
  unassignedLabel,
  executionCounts,
  heatmapEnabled,
  matchedControlIds,
  conflictBindingIds,
}: LabelColumnProps) {
  const { entryMap } = interaction;
  return (
    <div className={`mouse-top-labels mouse-top-labels--${side}`}>
      {controlIds.map((controlId) => {
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
            badge={badgeFor(controlId)}
            label={actionLabelFor(entry)}
            tooltip={tooltipText(entry, unassignedLabel)}
            dimmed={dimmed}
            conflict={conflict}
            executionCounts={executionCounts}
            heatmapEnabled={heatmapEnabled}
          />
        );
      })}
    </div>
  );
}
