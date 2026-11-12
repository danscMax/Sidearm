import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Layer } from "../lib/config";
import { placeSlot, slotHasMenu, type PlaceOutcome, type Slot } from "../lib/binding-moves";

export function useMouseVisualPanel(deps: {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  activeConfig: AppConfig;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
}) {
  const { effectiveProfileId, selectedLayer, activeConfig, updateDraft, showToast } = deps;
  const { t } = useTranslation();

  const [heatmapEnabled, setHeatmapEnabled] = useState(false);

  /** Drop a dragged button onto `to`: move, swap with an occupied one, or (Ctrl) copy. */
  function placeDragged(from: Slot, to: Slot, copy: boolean) {
    if (copy && slotHasMenu(activeConfig, from)) {
      showToast(t("binding.transferMenuBlocked"), "warning");
      return;
    }
    // The outcome is read from the current config, so the toast matches what the updater does.
    const { outcome } = placeSlot(activeConfig, from, to, copy ? "copy" : "move");
    if (outcome === "none") return;
    updateDraft((config) => placeSlot(config, from, to, copy ? "copy" : "move").config);
    const toasts: Record<Exclude<PlaceOutcome, "none">, string> = {
      moved: "binding.dragMoved",
      swapped: "binding.dragSwapped",
      copied: "binding.dragCopied",
    };
    showToast(t(toasts[outcome]), "success");
  }

  function handleDropBinding(targetControlId: ControlId, from: Slot, copy: boolean) {
    if (!effectiveProfileId) return;
    placeDragged(from, { profileId: effectiveProfileId, layer: selectedLayer, controlId: targetControlId }, copy);
  }

  return { heatmapEnabled, setHeatmapEnabled, handleDropBinding, placeDragged };
}
