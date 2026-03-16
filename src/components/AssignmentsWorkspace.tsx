import { startTransition, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
  Action,
  AppConfig,
  Binding,
  ControlId,
  Layer,
  PhysicalControl,
} from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVizPanel } from "../hooks/useMouseVizPanel";
import { makeBindingId, removeBinding, upsertBinding } from "../lib/config-editing";
import { MouseVisualization } from "./MouseVisualization";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";

export interface FamilySection {
  family: string;
  entries: ControlSurfaceEntry[];
}

export interface AssignmentsWorkspaceProps {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  multiSelectedControlIds: Set<ControlId>;
  familySections: FamilySection[];
  activeProfileName: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  onSelectLayer: (layer: Layer) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
  executionCounts?: Map<string, number>;
}

export function AssignmentsWorkspace({
  effectiveProfileId,
  selectedLayer,
  selectedControl: _selectedControl,
  selectedBinding: _selectedBinding,
  selectedAction: _selectedAction,
  multiSelectedControlIds,
  familySections,
  activeProfileName: _activeProfileName,
  updateDraft,
  onSelectLayer,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
  executionCounts,
}: AssignmentsWorkspaceProps) {
  const { t } = useTranslation();
  const handleOpenActionPicker = useActionPicker({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  });

  const { heatmapEnabled, setHeatmapEnabled, handleDropBinding } = useMouseVizPanel({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
  });

  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number;
    controlId: ControlId;
    binding: Binding | null;
    action: Action | null;
  } | null>(null);

  const [bindingClipboard, setBindingClipboard] = useState<{
    binding: Binding; action: Action;
  } | null>(null);

  const handleContextMenu = useCallback(
    (id: ControlId, binding: Binding | null, action: Action | null, x: number, y: number) => {
      setCtxMenu({ x, y, controlId: id, binding, action });
    },
    [],
  );

  function buildMenuItems(): (ContextMenuItem | null)[] {
    if (!ctxMenu || !effectiveProfileId) return [];
    const { controlId, binding, action } = ctxMenu;
    const otherLayer = selectedLayer === "standard" ? "hypershift" : "standard";
    const otherLayerLabel = otherLayer === "standard" ? "Standard" : "Hypershift";

    if (binding && action) {
      // Button with existing binding
      return [
        {
          label: t("common.edit"),
          onClick: () => handleOpenActionPicker(controlId, binding),
        },
        {
          label: t("assignments.copyBinding"),
          onClick: () => setBindingClipboard({ binding, action }),
        },
        {
          label: t("assignments.copyToLayer", { layer: otherLayerLabel }),
          onClick: () => {
            const newActionId = crypto.randomUUID();
            const newBindingId = makeBindingId(effectiveProfileId, otherLayer, controlId);
            updateDraft((config) => {
              const clonedAction = { ...action, id: newActionId };
              const clonedBinding: Binding = {
                ...binding,
                id: newBindingId,
                layer: otherLayer,
                actionRef: newActionId,
              };
              return upsertBinding(
                { ...config, actions: [...config.actions, clonedAction] },
                clonedBinding,
              );
            });
          },
        },
        null,
        {
          label: binding.enabled ? t("assignments.disable") : t("assignments.enable"),
          onClick: () =>
            updateDraft((config) =>
              upsertBinding(config, { ...binding, enabled: !binding.enabled }),
            ),
        },
        {
          label: t("assignments.clear"),
          danger: true,
          onClick: () => updateDraft((config) => removeBinding(config, binding.id)),
        },
      ];
    }

    // Empty button
    return [
      {
        label: t("assignments.assignAction"),
        onClick: () => handleOpenActionPicker(controlId, null),
      },
      {
        label: t("assignments.pasteBinding"),
        disabled: !bindingClipboard,
        onClick: () => {
          if (!bindingClipboard) return;
          const newActionId = crypto.randomUUID();
          const newBindingId = makeBindingId(effectiveProfileId, selectedLayer, controlId);
          updateDraft((config) => {
            const clonedAction = { ...bindingClipboard.action, id: newActionId };
            const clonedBinding: Binding = {
              ...bindingClipboard.binding,
              id: newBindingId,
              profileId: effectiveProfileId,
              layer: selectedLayer,
              controlId,
              actionRef: newActionId,
            };
            return upsertBinding(
              { ...config, actions: [...config.actions, clonedAction] },
              clonedBinding,
            );
          });
        },
      },
    ];
  }

  return (
    <div className="workspace__center" data-layer={selectedLayer}>
      <MouseVisualization
        entries={familySections.flatMap((section) => section.entries)}
        selectedLayer={selectedLayer}
        multiSelectedControlIds={multiSelectedControlIds}
        onSelectControl={(id) => {
          startTransition(() => {
            setSelectedControlId(id);
            setMultiSelectedControlIds(new Set());
          });
        }}
        onToggleMultiSelect={(id) => {
          setMultiSelectedControlIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onOpenActionPicker={handleOpenActionPicker}
        onSelectLayer={onSelectLayer}
        onContextMenu={handleContextMenu}
        executionCounts={executionCounts}
        heatmapEnabled={heatmapEnabled}
        onDropBinding={handleDropBinding}
      />
      <div className="heatmap-toggle">
        <button
          type="button"
          className={`action-button action-button--small${heatmapEnabled ? " action-button--active" : ""}`}
          onClick={() => setHeatmapEnabled((prev) => !prev)}
          title={heatmapEnabled ? t("profile.heatmapDisable") : t("profile.heatmapEnable")}
        >
          {heatmapEnabled ? t("profile.heatmapOn") : t("profile.heatmapOff")}
        </button>
      </div>
      {ctxMenu ? (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems()}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </div>
  );
}
