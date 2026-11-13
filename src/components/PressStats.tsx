import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPressLog } from "../lib/backend";
import type { AppConfig } from "../lib/config";
import { controlWithGesture, labelForLayer } from "../lib/labels";
import { holdHints, savedKeystrokes, sumDays, topPlaces, unusedPlaces, type PlaceCount, type PressLog } from "../lib/press-stats";
import { PillTrack } from "./PillTrack";
import { Notice } from "./shared";

/** Rows shown per list before "and N more". */
const SHOWN = 12;

interface PressStatsProps {
  config: AppConfig;
  deviceId: string;
  profileId: string | null;
  /** Adds a long press with the HyperShift binding's action (a hint's button). */
  onAddHold: (place: PlaceCount) => void;
}

/** The mouse's "Statistics" tab: presses over a week or a month (every computer's log, added up). */
export function PressStats({ config, deviceId, profileId, onAddHold }: PressStatsProps) {
  const { t } = useTranslation();
  const [log, setLog] = useState<PressLog | null>(null);
  const [failed, setFailed] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  useEffect(() => {
    let live = true;
    getPressLog().then((loaded) => { if (live) setLog(loaded); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed) return <Notice variant="warning">{t("stats.failed")}</Notice>;
  if (!log || !profileId) return <p className="panel__muted">{t("stats.loading")}</p>;
  const today = new Date();
  const now = sumDays(log, days, today);
  const before = sumDays(log, days, today, days);
  const top = topPlaces(config, now, before, profileId, deviceId);
  const unused = unusedPlaces(config, now, profileId, deviceId);
  const hints = holdHints(config, sumDays(log, 7, today), profileId, deviceId);
  const saved = savedKeystrokes(config, now);
  const total = top.reduce((n, place) => n + place.count, 0);
  const place = (entry: PlaceCount["binding"]) => `${controlWithGesture(entry.controlId, entry.triggerMode)} · ${labelForLayer(entry.layer)}`;
  const peak = Math.max(1, ...top.map((entry) => entry.count));

  return (
    <div className="press-stats">
      <div className="press-stats__head">
        <PillTrack
          items={[{ key: "7", label: t("stats.week") }, { key: "30", label: t("stats.month") }]}
          active={String(days)}
          onSelect={(key) => setDays(key === "30" ? 30 : 7)}
        />
        <p className="press-stats__summary">
          {t("stats.summary", { presses: total, saved })}
        </p>
      </div>

      {hints.length > 0 ? (
        <section className="press-stats__section">
          <h4 className="press-stats__title">{t("stats.hintsTitle")}</h4>
          <p className="panel__muted">{t("stats.hintsHelp")}</p>
          <ul className="press-stats__list">
            {hints.map((hint) => (
              <li key={hint.binding.id} className="press-stats__row press-stats__row--hint">
                <span className="press-stats__name">{hint.binding.label}</span>
                <span className="press-stats__where">{place(hint.binding)}</span>
                <span className="press-stats__count">{hint.count}×</span>
                <button type="button" className="action-button action-button--small" onClick={() => onAddHold(hint)}>
                  {t("stats.addHold")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="press-stats__section">
        <h4 className="press-stats__title">{t("stats.topTitle")}</h4>
        {top.length === 0 ? <p className="panel__muted">{t("stats.nothingYet")}</p> : (
          <ul className="press-stats__list">
            {top.slice(0, SHOWN).map((entry) => (
              <li key={entry.binding.id} className="press-stats__row">
                <span className="press-stats__name">{entry.binding.label}</span>
                <span className="press-stats__where">{place(entry.binding)}</span>
                <span className="press-stats__bar" aria-hidden="true">
                  <span className="press-stats__fill" ref={(el) => el?.style.setProperty("--share", String(entry.count / peak))} />
                </span>
                <span className="press-stats__count">{entry.count}×</span>
                <span className={`press-stats__trend${entry.count >= entry.before ? " press-stats__trend--up" : ""}`}
                  title={t("stats.before", { count: entry.before })}>
                  {entry.before === 0 ? t("stats.new") : entry.count === entry.before ? "=" : `${entry.count > entry.before ? "+" : "−"}${Math.abs(entry.count - entry.before)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {top.length > SHOWN ? <p className="panel__muted">{t("picker.alsoUsedMore", { count: top.length - SHOWN })}</p> : null}
      </section>

      <section className="press-stats__section">
        <h4 className="press-stats__title">{t("stats.unusedTitle", { count: unused.length })}</h4>
        <p className="panel__muted">{t("stats.unusedHelp")}</p>
        <ul className="press-stats__chips">
          {unused.map((binding) => (
            <li key={binding.id} className="press-stats__chip" title={place(binding)}>{binding.label} · {controlWithGesture(binding.controlId, binding.triggerMode)}</li>
          ))}
        </ul>
      </section>
      <p className="panel__muted help-sm">{t("stats.localOnly")}</p>
    </div>
  );
}
