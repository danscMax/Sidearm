import { useTranslation } from "react-i18next";

export function NagaV3Bottom() {
  const { t } = useTranslation();
  return (
    <svg className="mouse-svg__root naga-v3__underside" role="img"
      aria-label={t("visualization.v3BottomAlt")} viewBox="0 0 300 420">
      <path className="naga-v3__shell" d="M40 56 Q57 39 129 20 Q147 14 162 20 Q214 32 238 64 Q252 89 256 119 Q278 140 280 182 L275 244 Q274 304 238 351 Q201 396 147 400 Q76 399 40 345 Q16 308 16 253 Q17 198 26 144 Z" />
      <path className="naga-v3__detail" d="M46 62 Q148 18 226 61 L238 82 Q143 55 43 92 Z M36 298 Q85 370 145 376 Q211 371 251 299 L255 324 Q211 396 145 388 Q78 387 34 325 Z" />
      <rect className="naga-v3__panel" x="116" y="149" width="58" height="77" rx="18" />
      <circle className="naga-v3__detail" cx="145" cy="185" r="10" />
      <circle className="naga-v3__detail" cx="145" cy="334" r="33" />
      <rect className="naga-v3__panel" x="204" y="110" width="28" height="14" rx="5" />
      <rect className="naga-v3__panel" x="77" y="110" width="30" height="14" rx="5" />
      <path className="naga-v3__detail" d="M88 110 V124 M220 110 V124" />
      <text x="92" y="145">{t("visualization.v3Connection")}</text>
      <text x="217" y="145">{t("visualization.v3RingLock")}</text>
      <circle className="naga-v3__indicator" cx="145" cy="246" r="3" />
      <rect className="naga-v3__panel" x="129" y="257" width="32" height="26" rx="5" />
    </svg>
  );
}
