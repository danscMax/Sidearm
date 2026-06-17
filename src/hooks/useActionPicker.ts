import { useCallback } from "react";
import type { AppConfig, Binding, ControlId, Layer } from "../lib/config";
import { ensurePlaceholderBinding } from "../lib/config-editing";

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

      // Capture the id ensurePlaceholderBinding actually assigns. Reconstructing
      // it independently would diverge on a base-id collision (audit F010),
      // leaving the picker pointed at a non-existent binding.
      let createdBindingId: string | null = null;
      updateDraft((config) => {
        const control = config.physicalControls.find((c) => c.id === controlId);
        if (!control) return config;
        const result = ensurePlaceholderBinding(config, effectiveProfileId, selectedLayer, control);
        createdBindingId = result.bindingId;
        return result.config;
      });

      if (createdBindingId === null) return;
      setActionPickerBindingId(createdBindingId);
      setActionPickerOpen(true);
    },
    [effectiveProfileId, selectedLayer, updateDraft, setActionPickerBindingId, setActionPickerOpen],
  );

  return handleOpenActionPicker;
}
