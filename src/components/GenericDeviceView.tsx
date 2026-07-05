import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlId, Device } from "../lib/config";
import { buildHotspotTooltip } from "../lib/labels";
import { actionLabel, type MouseVisualizationProps, type TriggerBadgeLabels } from "../lib/mouse-visual";
import { useControlInteractions } from "../hooks/useControlInteractions";
import { LegendCell } from "./mouse-visual/LegendCell";
import { LayerPills } from "./mouse-visual/LayerPills";

interface GenericDeviceViewProps extends MouseVisualizationProps {
  device: Device;
  onAddControl: () => void;
  onRemoveControl: (id: ControlId) => void;
  onRenameDevice: (name: string) => void;
  onDeleteDevice: () => void;
}

/** Visualization for a user-added device: a legend grid of its learned
 * controls (photo + hotspots arrive with the device-image slice). Reuses the
 * same entry/interaction pipeline as the Naga views, so selection, drag-drop,
 * heatmap and the action picker behave identically. */
export function GenericDeviceView({
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
  heatmapEnabled,
  onDropBinding,
  device,
  onAddControl,
  onRemoveControl,
  onRenameDevice,
  onDeleteDevice,
}: GenericDeviceViewProps) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name);
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
  const triggerLabels: TriggerBadgeLabels = {
    hold: t("visualization.badgeHold"),
    chord: t("visualization.badgeChord"),
  };

  function commitName() {
    setEditingName(false);
    if (nameDraft.trim() && nameDraft.trim() !== device.name) {
      onRenameDevice(nameDraft);
    } else {
      setNameDraft(device.name);
    }
  }

  return (
    <div className="mouse-visual-tabs gdv" data-layer={selectedLayer}>
      <div className="gdv__header">
        {editingName ? (
          <input
            type="text"
            className="gdv__name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setNameDraft(device.name);
                setEditingName(false);
              }
            }}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit rename click
            autoFocus
          />
        ) : (
          <h3 className="gdv__name">{device.name}</h3>
        )}
        <button
          type="button"
          className="action-button action-button--small"
          onClick={() => {
            setNameDraft(device.name);
            setEditingName(true);
          }}
        >
          {t("device.rename")}
        </button>
        <button
          type="button"
          className="action-button action-button--small"
          onClick={onAddControl}
        >
          {t("device.addControl")}
        </button>
        <button
          type="button"
          className="action-button action-button--small action-button--danger"
          onClick={onDeleteDevice}
        >
          {t("device.delete")}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="gdv__empty">
          <p className="panel__muted">{t("device.emptyHint")}</p>
          <button type="button" className="action-button action-button--accent" onClick={onAddControl}>
            {t("device.addControl")}
          </button>
        </div>
      ) : (
        <div className="gdv__grid">
          {entries.map((entry, index) => {
            const controlId = entry.control.id;
            const selected = entry.isSelected || multiSelectedControlIds.has(controlId);
            const dimmed = matchedControlIds != null && !matchedControlIds.has(controlId);
            const conflict = !!entry.binding && (conflictBindingIds?.has(entry.binding.id) ?? false);
            return (
              <div key={controlId} className="gdv__cell">
                <LegendCell
                  entry={entry}
                  controlId={controlId}
                  interaction={interaction}
                  selected={selected}
                  badge={String(index + 1)}
                  label={`${entry.control.defaultName} · ${actionLabel(entry, { triggerLabels })}`}
                  tooltip={buildHotspotTooltip(
                    entry,
                    selectedLayer,
                    executionHistory?.get(controlId),
                    executionCounts?.get(controlId) ?? 0,
                  )}
                  nativeTooltip
                  dimmed={dimmed}
                  conflict={conflict}
                  executionCounts={executionCounts}
                  heatmapEnabled={heatmapEnabled}
                />
                <button
                  type="button"
                  className="gdv__cell-remove"
                  title={t("device.deleteControl")}
                  aria-label={t("device.deleteControl", { name: entry.control.defaultName })}
                  onClick={() => onRemoveControl(controlId)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <LayerPills selectedLayer={selectedLayer} onSelectLayer={onSelectLayer} />
    </div>
  );
}
