import { useTranslation } from "react-i18next";

/** Segmented choice grid (one active button per option). Shared by the
 *  media-key and mouse-action editors. `label` is an i18n key. */
export function PickerGrid<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="picker-grid">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`picker-grid__btn${value === opt.value ? " picker-grid__btn--active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {t(opt.label)}
        </button>
      ))}
    </div>
  );
}
