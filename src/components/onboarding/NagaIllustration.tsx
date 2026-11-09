import { useTranslation } from "react-i18next";

/**
 * Stylised Razer Naga thumb-grid (12 buttons, 3×4) used by the onboarding
 * live-test step. Buttons light up as their press arrives from the
 * `encoded_key_received` stream. Purely presentational.
 */

interface NagaIllustrationProps {
  /** 1-based button numbers that have been detected (their F-key arrived). */
  detected: Set<number>;
  /** 1-based button currently being pressed (flash highlight), or null. */
  active: number | null;
  /** Localized accessible name for the illustration. */
  label: string;
}

// The Naga side grid is laid out 3 columns × 4 rows: 1-2-3 / 4-5-6 / 7-8-9 / 10-11-12.
const BUTTONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function NagaIllustration({ detected, active, label }: NagaIllustrationProps) {
  const { t } = useTranslation();
  return (
    <div className="onb-naga" role="img" aria-label={label}>
      <div className="onb-naga__body">
        <div className="onb-naga__grid">
          {BUTTONS.map((n) => {
            const isDetected = detected.has(n);
            const isActive = active === n;
            const cls = [
              "onb-naga__btn",
              isDetected ? "is-detected" : "",
              isActive ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={n} className={cls} aria-label={t("onboarding.buttonN", { n })}>
                <span className="onb-naga__num">{n}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
