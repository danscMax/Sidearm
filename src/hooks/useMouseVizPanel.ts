import { useState, useCallback } from "react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import { makeBindingId, upsertBinding } from "../lib/config-editing";

export function useMouseVizPanel(deps: {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
}) {
  const { effectiveProfileId, selectedLayer, updateDraft } = deps;

  const [heatmapEnabled, setHeatmapEnabled] = useState(false);

  const handleDropBinding = useCallback(
    (targetControlId: ControlId, sourceActionId: string) => {
      if (!effectiveProfileId) return;
      updateDraft((config) => {
        const sourceAction = config.actions.find((a) => a.id === sourceActionId);
        if (!sourceAction) return config;
        const newAction = { ...sourceAction, id: crypto.randomUUID() };
        const bindingId = makeBindingId(effectiveProfileId, selectedLayer, targetControlId);
        const newBinding: Binding = {
          id: bindingId,
          profileId: effectiveProfileId,
          layer: selectedLayer,
          controlId: targetControlId,
          label: newAction.pretty,
          actionRef: newAction.id,
          enabled: true,
        };
        return upsertBinding(
          { ...config, actions: [...config.actions, newAction] },
          newBinding,
        );
      });
    },
    [effectiveProfileId, selectedLayer, updateDraft],
  );

  return { heatmapEnabled, setHeatmapEnabled, handleDropBinding };
}
