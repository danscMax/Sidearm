import type { DevicePresetId } from "../lib/device-presets";

/** Crisp inline SVG hardware schematics for generic/custom devices.
 *  Uses currentColor and CSS tokens so both dark and light themes stay balanced. */
export function DevicePresetArt({
  preset,
  compact = false,
}: {
  preset: DevicePresetId;
  compact?: boolean;
}) {
  const className = compact ? "gdv__preset-svg gdv__preset-svg--thumb" : "gdv__preset-svg";

  if (preset === "preset-mouse.svg") {
    return (
      <svg className={className} viewBox="0 0 360 240" fill="none" aria-hidden="true">
        {/* Subtle studio grid */}
        <rect x="8" y="8" width="344" height="224" rx="14" stroke="currentColor" strokeOpacity="0.08" />
        {/* Top-down ergonomic mouse silhouette */}
        <path
          d="M132 58 C132 30 154 20 180 20 C206 20 228 30 228 58 L234 148 C236 190 214 218 180 218 C146 218 124 190 126 148 Z"
          fill="currentColor"
          fillOpacity="0.04"
          stroke="currentColor"
          strokeOpacity="0.34"
          strokeWidth="2"
        />
        {/* Left/Right click split & palm seam */}
        <line x1="180" y1="21" x2="180" y2="92" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
        <path d="M128 92 Q180 98 232 92" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
        {/* Scroll wheel */}
        <rect
          x="172"
          y="42"
          width="16"
          height="36"
          rx="8"
          fill="currentColor"
          fillOpacity="0.08"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.6"
        />
        {/* Thumb side buttons (Mouse4 / Mouse5) */}
        <rect x="118" y="96" width="9" height="24" rx="4" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeOpacity="0.48" strokeWidth="1.4" />
        <rect x="118" y="126" width="9" height="24" rx="4" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeOpacity="0.48" strokeWidth="1.4" />
        {/* Subtle DPI button below wheel */}
        <rect x="176" y="85" width="8" height="12" rx="3" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.2" />
      </svg>
    );
  }

  if (preset === "preset-mmo-mouse.svg") {
    return (
      <svg className={className} viewBox="0 0 360 240" fill="none" aria-hidden="true">
        <rect x="8" y="8" width="344" height="224" rx="14" stroke="currentColor" strokeOpacity="0.08" />
        {/* Mouse body shifted slightly right to make room for thumb-grid callout */}
        <path
          d="M158 54 C158 28 178 20 206 20 C234 20 256 30 256 58 L262 150 C264 190 242 218 208 218 C174 218 152 192 154 150 Z"
          fill="currentColor"
          fillOpacity="0.04"
          stroke="currentColor"
          strokeOpacity="0.34"
          strokeWidth="2"
        />
        <line x1="206" y1="21" x2="206" y2="88" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
        <path d="M156 88 Q206 94 259 88" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
        <rect x="198" y="40" width="16" height="34" rx="8" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.6" />
        {/* Expanded 3x4 MMO thumb grid panel */}
        <rect x="64" y="68" width="82" height="114" rx="10" fill="currentColor" fillOpacity="0.05" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
        {[0, 1, 2].map((col) =>
          [0, 1, 2, 3].map((row) => (
            <rect
              key={`${col}-${row}`}
              x={72 + col * 24}
              y={78 + row * 24}
              width="18"
              height="18"
              rx="4"
              fill="currentColor"
              fillOpacity="0.08"
              stroke="currentColor"
              strokeOpacity="0.32"
              strokeWidth="1.2"
            />
          )),
        )}
      </svg>
    );
  }

  if (preset === "preset-macropad.svg") {
    return (
      <svg className={className} viewBox="0 0 360 240" fill="none" aria-hidden="true">
        <rect x="8" y="8" width="344" height="224" rx="14" stroke="currentColor" strokeOpacity="0.08" />
        {/* Macropad aluminum case */}
        <rect x="52" y="28" width="256" height="184" rx="18" fill="currentColor" fillOpacity="0.04" stroke="currentColor" strokeOpacity="0.36" strokeWidth="2" />
        {/* Rotary encoder knob top-right */}
        <circle cx="272" cy="64" r="18" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.8" />
        <circle cx="272" cy="64" r="9" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1.2" />
        {/* 4x3 tactile keycap grid */}
        {[0, 1, 2, 3].map((col) =>
          [0, 1, 2].map((row) => {
            if (col === 3 && row === 0) return null;
            return (
              <rect
                key={`${col}-${row}`}
                x={74 + col * 54}
                y={46 + row * 52}
                width="42"
                height="42"
                rx="8"
                fill="currentColor"
                fillOpacity="0.07"
                stroke="currentColor"
                strokeOpacity="0.34"
                strokeWidth="1.5"
              />
            );
          }),
        )}
      </svg>
    );
  }

  // preset-keyboard.svg
  return (
    <svg className={className} viewBox="0 0 360 240" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="344" height="224" rx="14" stroke="currentColor" strokeOpacity="0.08" />
      {/* Compact keyboard chassis */}
      <rect x="26" y="48" width="308" height="144" rx="14" fill="currentColor" fillOpacity="0.04" stroke="currentColor" strokeOpacity="0.36" strokeWidth="2" />
      {/* Top function row */}
      {Array.from({ length: 12 }).map((_, i) => (
        <rect
          key={`f-${i}`}
          x={40 + i * 23}
          y={62}
          width="18"
          height="16"
          rx="3"
          fill="currentColor"
          fillOpacity="0.08"
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeWidth="1.1"
        />
      ))}
      {/* Main rows */}
      {[0, 1, 2].map((row) =>
        Array.from({ length: 12 }).map((_, col) => (
          <rect
            key={`k-${row}-${col}`}
            x={40 + col * 23}
            y={86 + row * 24}
            width="18"
            height="18"
            rx="3.5"
            fill="currentColor"
            fillOpacity="0.06"
            stroke="currentColor"
            strokeOpacity="0.28"
            strokeWidth="1.1"
          />
        )),
      )}
      {/* Spacebar row */}
      <rect x="40" y="158" width="34" height="18" rx="3.5" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.1" />
      <rect x="80" y="158" width="134" height="18" rx="3.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.1" />
      <rect x="220" y="158" width="34" height="18" rx="3.5" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.1" />
      <rect x="260" y="158" width="52" height="18" rx="3.5" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.1" />
    </svg>
  );
}
