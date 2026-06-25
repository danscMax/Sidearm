import { useTranslation } from "react-i18next";
import type { OsdPosition } from "../../lib/config";

const CORNERS: ReadonlyArray<{ value: OsdPosition; labelKey: string }> = [
  { value: "topLeft", labelKey: "settings.osdPositionTopLeft" },
  { value: "topRight", labelKey: "settings.osdPositionTopRight" },
  { value: "bottomLeft", labelKey: "settings.osdPositionBottomLeft" },
  { value: "bottomRight", labelKey: "settings.osdPositionBottomRight" },
];

/**
 * A 2×2 corner picker: a small "screen" rectangle with four corner buttons,
 * replacing the PillTrack for the OSD position. Styling is via CSS classes +
 * a `data-corner` attribute (no inline style). Reuses the existing
 * `settings.osdPosition*` labels as titles / aria-labels.
 */
export function CornerPicker({
  value,
  onSelect,
}: {
  value: OsdPosition;
  onSelect: (value: OsdPosition) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="corner-picker" role="radiogroup" aria-label={t("settings.osdPosition")}>
      {CORNERS.map((corner) => {
        const label = t(corner.labelKey);
        return (
          <button
            key={corner.value}
            type="button"
            data-corner={corner.value}
            className={`corner-picker__corner${corner.value === value ? " corner-picker__corner--active" : ""}`}
            role="radio"
            aria-checked={corner.value === value}
            aria-label={label}
            title={label}
            onClick={() => onSelect(corner.value)}
          >
            <span className="corner-picker__dot" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
