import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlId, Device } from "../lib/config";
import { readDeviceImage } from "../lib/backend";
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
  onPickImage: () => void;
  onPlaceHotspot: (controlId: ControlId, x: number, y: number) => void;
}

/** Visualization for a user-added device: an optional photo with click-to-place
 * hotspots plus a legend grid of its learned controls. Reuses the same
 * entry/interaction pipeline as the Naga views, so selection, drag-drop,
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
  onPickImage,
  onPlaceHotspot,
}: GenericDeviceViewProps) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
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

  // The config stores a bare file name; the photo itself is served as a
  // data: URL (asset-protocol scopes can't cover the portable build).
  useEffect(() => {
    let cancelled = false;
    setPlacing(false);
    if (!device.image) {
      setImageUrl(null);
      return;
    }
    readDeviceImage(device.image)
      .then((url) => {
        if (!cancelled) setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [device.image]);

  function commitName() {
    setEditingName(false);
    if (nameDraft.trim() && nameDraft.trim() !== device.name) {
      onRenameDevice(nameDraft);
    } else {
      setNameDraft(device.name);
    }
  }

  const placedIds = new Set((device.hotspots ?? []).map((hotspot) => hotspot.controlId));

  function handlePhotoClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!placing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const selected =
      entries.find((entry) => entry.isSelected) ??
      entries.find((entry) => !placedIds.has(entry.control.id));
    if (!selected) return;
    onPlaceHotspot(selected.control.id, x, y);
    // Auto-advance to the next control that has no hotspot yet, so placing a
    // whole device is click-click-click rather than select-click each time.
    const next = entries.find(
      (entry) => entry.control.id !== selected.control.id && !placedIds.has(entry.control.id),
    );
    if (next) onSelectControl(next.control.id);
  }

  function renderHotspots() {
    return (device.hotspots ?? []).map((hotspot) => {
      const entry = entryMap.get(hotspot.controlId);
      if (!entry) return null;
      const index = entries.indexOf(entry);
      const isAssigned =
        entry.binding && entry.binding.enabled && entry.action && entry.action.type !== "disabled";
      const assignedClass = isAssigned
        ? ` mouse-visual__hotspot--assigned mouse-visual__hotspot--type-${entry.action?.type}`
        : " mouse-visual__hotspot--unassigned";
      const isSelected = entry.isSelected || multiSelectedControlIds.has(entry.control.id);
      const isDimmed = matchedControlIds != null && !matchedControlIds.has(entry.control.id);
      const hasConflict = !!entry.binding && (conflictBindingIds?.has(entry.binding.id) ?? false);
      return (
        <button
          type="button"
          key={hotspot.controlId}
          className={`mouse-visual__hotspot${
            isSelected ? " mouse-visual__hotspot--selected" : assignedClass
          }${hoveredId === entry.control.id ? " mouse-visual__hotspot--hovered" : ""}${
            dragOverId === entry.control.id ? " mouse-visual__hotspot--dragover" : ""
          }${isDimmed ? " mouse-visual__hotspot--dimmed" : ""}${
            hasConflict ? " mouse-visual__hotspot--conflict" : ""
          }`}
          ref={(el) => {
            if (el) {
              el.style.setProperty("--hotspot-left", `${hotspot.x}%`);
              el.style.setProperty("--hotspot-top", `${hotspot.y}%`);
            }
            applyHeatBg(el, entry.control.id);
          }}
          title={buildHotspotTooltip(
            entry,
            selectedLayer,
            executionHistory?.get(entry.control.id),
            executionCounts?.get(entry.control.id) ?? 0,
          )}
          draggable={!!entry.binding && !!entry.action}
          {...getInteractionProps(entry.control.id)}
        >
          {index + 1}
        </button>
      );
    });
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
          className="action-button action-button--small"
          onClick={onPickImage}
        >
          {device.image ? t("device.replacePhoto") : t("device.addPhoto")}
        </button>
        {imageUrl && entries.length > 0 ? (
          <button
            type="button"
            className={`action-button action-button--small${placing ? " action-button--active" : ""}`}
            aria-pressed={placing}
            onClick={() => setPlacing((prev) => !prev)}
          >
            {t("device.placeHotspots")}
          </button>
        ) : null}
        <button
          type="button"
          className="action-button action-button--small action-button--danger"
          onClick={onDeleteDevice}
        >
          {t("device.delete")}
        </button>
      </div>

      {imageUrl ? (
        <>
          {placing ? <p className="panel__muted gdv__placing-hint">{t("device.placingHint")}</p> : null}
          {/* Click-to-place is a pointer flow by design; keyboard users place
              nothing here — every control stays reachable in the grid below. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
          <div
            className={`mouse-visual gdv__photo${placing ? " gdv__photo--placing" : ""}`}
            onClick={handlePhotoClick}
          >
            <img className="mouse-visual__img" src={imageUrl} alt={device.name} draggable={false} />
            <div className="mouse-visual__overlay">{renderHotspots()}</div>
          </div>
        </>
      ) : null}

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
