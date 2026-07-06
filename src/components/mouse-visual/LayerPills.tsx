// The layer-select pill strip rendered in the footer of both visualizers.

import { useTranslation } from "react-i18next";
import type { Layer } from "../../lib/config";
import { layerCopy } from "../../lib/constants";
import { PillTrack } from "../PillTrack";

interface LayerPillsProps {
  selectedLayer: Layer;
  onSelectLayer: (layer: Layer) => void;
  /** Generic (non-Razer) devices label the layers neutrally — "Hypershift"
   *  is Naga vocabulary (UI-review U4/UX7). */
  neutralLabels?: boolean;
}

export function LayerPills({ selectedLayer, onSelectLayer, neutralLabels }: LayerPillsProps) {
  const { t } = useTranslation();
  return (
    <div className="mouse-visual-tabs__footer">
      <PillTrack
        className="pill-track--layer"
        indicatorModifier={selectedLayer}
        active={selectedLayer}
        onSelect={onSelectLayer}
        items={layerCopy.map((layer, index) => ({
          key: layer.value,
          label: neutralLabels ? t("layer.neutral", { n: index + 1 }) : t(layer.label),
        }))}
      />
    </div>
  );
}
