// The layer-select pill strip rendered in the footer of both visualizers.

import { useTranslation } from "react-i18next";
import type { Layer } from "../../lib/config";
import { layerCopy } from "../../lib/constants";
import { PillTrack } from "../PillTrack";

interface LayerPillsProps {
  selectedLayer: Layer;
  onSelectLayer: (layer: Layer) => void;
}

export function LayerPills({ selectedLayer, onSelectLayer }: LayerPillsProps) {
  const { t } = useTranslation();
  return (
    <div className="mouse-visual-tabs__footer">
      <PillTrack
        className="pill-track--layer"
        indicatorModifier={selectedLayer}
        active={selectedLayer}
        onSelect={onSelectLayer}
        items={layerCopy.map((layer) => ({ key: layer.value, label: t(layer.label) }))}
      />
    </div>
  );
}
