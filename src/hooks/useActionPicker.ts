import type { AppConfig, Binding, ControlId } from "../lib/config";

export function useActionPicker(deps: {
  effectiveProfileId: string | null;
  config: AppConfig | null;
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
    // Opening and cancelling are read-only. A new binding is created on Save.
    setActionPickerBindingId(binding?.id ?? null);
    setActionPickerOpen(true);
  }

  return handleOpenActionPicker;
}
