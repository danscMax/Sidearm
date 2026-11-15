import { isOfflineLayer, type AppConfig, type Binding, type ControlId, type Layer } from "../lib/config";
import type { OfflinePreview } from "../lib/onboard-mapping";

export function useActionPicker(deps: {
  effectiveProfileId: string | null;
  config: AppConfig | null;
  selectedLayer: Layer;
  offlinePreview: OfflinePreview | null;
  setSelectedControlId: (id: ControlId | null) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
}) {
  const {
    effectiveProfileId,
    config,
    setActionPickerBindingId,
    setActionPickerOpen,
  } = deps;

  function handleOpenActionPicker(controlId: ControlId, binding: Binding | null) {
    if (!effectiveProfileId || !config?.physicalControls.some((c) => c.id === controlId)) return;
    if (isOfflineLayer(deps.selectedLayer) && !deps.offlinePreview?.controls.some((control) =>
      control.controlId === controlId && control.layer === deps.selectedLayer && control.editable)) return;
    // Opening and cancelling are read-only. A new binding is created on Save.
    deps.setSelectedControlId(controlId);
    setActionPickerBindingId(binding?.id ?? null);
    setActionPickerOpen(true);
  }

  return handleOpenActionPicker;
}
