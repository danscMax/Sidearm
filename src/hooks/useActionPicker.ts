import { useCallback } from "react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import {
  ensurePlaceholderBinding,
  makeBindingId,
} from "../lib/config-editing";

export function useActionPicker(deps: {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
}) {
  const {
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  } = deps;

  const handleOpenActionPicker = useCallback(
    (controlId: ControlId, binding: Binding | null) => {
      if (!effectiveProfileId) return;

      if (binding) {
        setActionPickerBindingId(binding.id);
        setActionPickerOpen(true);
        return;
      }

      updateDraft((config) => {
        const control = config.physicalControls.find((c) => c.id === controlId);
        if (!control) return config;
        return ensurePlaceholderBinding(config, effectiveProfileId, selectedLayer, control);
      });

      const bindingId = makeBindingId(effectiveProfileId, selectedLayer, controlId);
      setActionPickerBindingId(bindingId);
      setActionPickerOpen(true);
    },
    [effectiveProfileId, selectedLayer, updateDraft, setActionPickerBindingId, setActionPickerOpen],
  );

  return handleOpenActionPicker;
}
