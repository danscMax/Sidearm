// The layer-select pill strip rendered in the footer of both visualizers.

import type { Layer } from "../../lib/config";
import { layerCopy } from "../../lib/constants";

interface LayerPillsProps {
  selectedLayer: Layer;
  onSelectLayer: (layer: Layer) => void;
}

export function LayerPills({ selectedLayer, onSelectLayer }: LayerPillsProps) {
  const layerIdx = layerCopy.findIndex((l) => l.value === selectedLayer);
  return (
    <div className="mouse-visual-tabs__footer">
      <div
        className="pill-track pill-track--layer"
        ref={(el) => {
          if (el) el.style.setProperty("--pill-count", String(layerCopy.length));
        }}
      >
        {layerIdx >= 0 ? (
          <div
            className={`pill-track__indicator pill-track__indicator--${selectedLayer}`}
            ref={(el) => {
              if (el) el.style.setProperty("--pill-offset", `${layerIdx * 100}%`);
            }}
          />
        ) : null}
        {layerCopy.map((layer) => (
          <button
            key={layer.value}
            type="button"
            aria-pressed={layer.value === selectedLayer}
            className={`pill-track__pill${layer.value === selectedLayer ? " pill-track__pill--active" : ""}`}
            onClick={() => onSelectLayer(layer.value)}
          >
            {layer.label}
          </button>
        ))}
      </div>
    </div>
  );
}
