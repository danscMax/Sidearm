import type { ReactNode } from "react";

export interface PillTrackItem<T extends string> {
  key: T;
  label: ReactNode;
}

/**
 * Animated segmented pill selector. The sliding `pill-track__indicator` is
 * positioned via CSS custom properties set through the CSSOM (not inline
 * `style`), so it survives the strict CSP without 'unsafe-inline'.
 *
 * Shared by the view-mode tabs, layer selector, and sidebar profile switch.
 * `indicatorModifier` adds `pill-track__indicator--{value}` (layer tinting);
 * `renderTrailing` injects per-pill trailing content (e.g. the runtime dot).
 */
export function PillTrack<T extends string>({
  items,
  active,
  onSelect,
  className,
  indicatorModifier,
  renderTrailing,
  pillProps,
}: {
  items: ReadonlyArray<PillTrackItem<T>>;
  active: T;
  onSelect: (key: T) => void;
  className?: string;
  indicatorModifier?: string;
  renderTrailing?: (item: PillTrackItem<T>) => ReactNode;
  pillProps?: (item: PillTrackItem<T>) => React.ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const activeIdx = items.findIndex((item) => item.key === active);
  return (
    <div
      className={`pill-track${className ? ` ${className}` : ""}`}
      ref={(el) => {
        if (el) el.style.setProperty("--pill-count", String(items.length));
      }}
    >
      {activeIdx >= 0 ? (
        <div
          className={`pill-track__indicator${indicatorModifier ? ` pill-track__indicator--${indicatorModifier}` : ""}`}
          ref={(el) => {
            if (el) el.style.setProperty("--pill-offset", `${activeIdx * 100}%`);
          }}
        />
      ) : null}
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={item.key === active}
          className={`pill-track__pill${item.key === active ? " pill-track__pill--active" : ""}`}
          onClick={() => onSelect(item.key)}
          {...pillProps?.(item)}
        >
          {item.label}
          {renderTrailing?.(item)}
        </button>
      ))}
    </div>
  );
}
