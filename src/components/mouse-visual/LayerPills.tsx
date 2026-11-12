// The layer-select pill strip rendered in the footer of both visualizers.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Layer } from "../../lib/config";
import { layerCopy } from "../../lib/constants";
import { isBindingDrag } from "../../lib/mouse-visual";
import { PillTrack } from "../PillTrack";

const LAYER_HOVER_MS = 450;

interface LayerPillsProps {
  selectedLayer: Layer;
  onSelectLayer: (layer: Layer) => void;
  /** Generic (non-Razer) devices label the layers neutrally — "Hypershift"
   *  is Naga vocabulary (UI-review U4/UX7). */
  neutralLabels?: boolean;
  /** Layers offered; absent = standard and HyperShift. */
  layers?: readonly Layer[];
}

export function LayerPills({ selectedLayer, onSelectLayer, neutralLabels, layers = ["standard", "hypershift"] }: LayerPillsProps) {
  const { t } = useTranslation();
  // A button dragged over a pill opens that layer after a short hover, so it
  // can be dropped onto a button of another layer.
  const hoverTimer = useRef<number | null>(null);
  const stopHover = () => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  return (
    <div className="mouse-visual-tabs__footer">
      <PillTrack
        className="pill-track--layer"
        indicatorModifier={selectedLayer}
        active={selectedLayer}
        onSelect={onSelectLayer}
        pillProps={(item) => ({
          onDragEnter: (e) => {
            if (!isBindingDrag(e) || item.key === selectedLayer) return;
            stopHover();
            hoverTimer.current = window.setTimeout(() => onSelectLayer(item.key), LAYER_HOVER_MS);
          },
          onDragOver: (e) => { if (isBindingDrag(e)) e.preventDefault(); },
          onDragLeave: stopHover,
          onDrop: stopHover,
        })}
        items={layerCopy.filter((layer) => layers.includes(layer.value)).map((layer, index) => ({
          key: layer.value,
          label: neutralLabels ? t("layer.neutral", { n: index + 1 }) : t(layer.label),
        }))}
      />
    </div>
  );
}
