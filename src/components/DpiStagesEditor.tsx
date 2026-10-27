import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DPI_STAGE_PRESETS, MAX_DPI_STAGES, nextAddedDpiStage, normalizeDpiStages, replaceDpiStage } from "../lib/dpi-stages";

interface Props {
  stages: number[];
  startingDpi: number | undefined;
  currentDpi: number | undefined;
  dpiMin: number;
  dpiMax: number;
  busy: boolean;
  onSave: (stages: number[] | undefined, startingDpi: number | undefined) => void;
}

/** Profile-owned DPI stage editor; mouse writes are delegated to MouseWorkspace. */
export function DpiStagesEditor({ stages, startingDpi, currentDpi, dpiMin, dpiMax, busy, onSave }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [inlineDraft, setInlineDraft] = useState("");
  const selected = stages.includes(startingDpi ?? -1) ? startingDpi! : stages[0];
  useEffect(() => { setDraft(selected === undefined ? "" : String(selected)); }, [selected]);
  const next = Number(draft);
  const updated = draft.trim() ? replaceDpiStage(stages, selected, next, dpiMin, dpiMax) : null;
  function updateStage(previous: number, value: string): boolean {
    const changed = value.trim() ? replaceDpiStage(stages, previous, Number(value), dpiMin, dpiMax) : null;
    if (!changed || busy) return false;
    onSave(changed, startingDpi === previous ? Number(value) : startingDpi);
    return true;
  }
  return (
    <div className="dpi-stages" role="group" aria-label={t("mouse.stageTitle")}>
      <div className="dpi-stages__heading">
        <strong>{t("mouse.stageTitle")}</strong>
        <p className="panel__muted help-sm">{t("mouse.stageInfo")}</p>
      </div>
      {!stages.length ? (
        <div className="dpi-stages__empty">
          <span className="panel__muted">{t("mouse.stageDisabled")}</span>
          <button type="button" className="action-button action-button--secondary action-button--small" disabled={busy}
            onClick={() => {
              const presets = normalizeDpiStages(DPI_STAGE_PRESETS.filter((n) => n >= dpiMin && n <= dpiMax), dpiMin, dpiMax);
              if (presets) onSave(presets, presets.includes(startingDpi ?? -1) ? startingDpi : presets[Math.floor(presets.length / 2)]);
            }}>{t("mouse.stageAddPreset")}</button>
        </div>
      ) : (
        <>
          <div className="dpi-stages__rail" role="group" aria-label={t("mouse.stageTitle")}>
            {stages.map((dpi) => editing === dpi ? (
              <div className="dpi-stages__step dpi-stages__step--chosen" key={dpi}>
                <span className="dpi-stages__dot" />
                <input autoFocus type="number" className="dpi-stages__inline-input"
                  aria-label={t("mouse.stageInlineEdit", { dpi })} min={dpiMin} max={dpiMax} step={50}
                  value={inlineDraft} disabled={busy}
                  onChange={(event) => setInlineDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); if (updateStage(dpi, inlineDraft)) setEditing(null); }
                    if (event.key === "Escape") { event.stopPropagation(); setEditing(null); }
                  }} onBlur={() => setEditing(null)} />
              </div>
            ) : (
              <button key={dpi} type="button" disabled={busy}
                className={`dpi-stages__step${dpi === (currentDpi ?? startingDpi) ? " dpi-stages__step--chosen" : ""}`}
                aria-pressed={dpi === startingDpi} aria-label={t("mouse.stageChoose", { dpi })}
                title={t("mouse.stageDoubleClick")}
                onClick={() => onSave(stages, dpi)}
                onDoubleClick={() => { setInlineDraft(String(dpi)); setEditing(dpi); }}>
                <span className="dpi-stages__dot" />
                <span>{dpi}</span>
              </button>
            ))}
          </div>
          <p className="panel__muted help-sm">{t("mouse.stageHelp")}</p>
          <p className="panel__muted help-sm">{t("mouse.stageDoubleClick")}</p>
          <p className="panel__muted help-sm" role="status">{currentDpi !== undefined
            ? t("mouse.stageHardware", { dpi: currentDpi })
            : t("mouse.stageSelected", { dpi: startingDpi })}</p>
          <div className="dpi-stages__editing">
            <label className="field"><span className="field__label">{t("mouse.stageEdit")}</span>
              <input type="number" aria-label={t("mouse.stageEdit")} value={draft}
                min={dpiMin} max={dpiMax} step={50} disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && updated) { e.preventDefault(); updateStage(selected, draft); } }} />
            </label>
            <button type="button" className="action-button action-button--secondary action-button--small"
              disabled={busy || !updated} onClick={() => updateStage(selected, draft)}>{t("mouse.stageSave")}</button>
            <button type="button" className="action-button action-button--secondary action-button--small"
              disabled={busy || stages.length >= MAX_DPI_STAGES || nextAddedDpiStage(stages, dpiMin, dpiMax) === null}
              onClick={() => { const value = nextAddedDpiStage(stages, dpiMin, dpiMax); if (value !== null) onSave([...stages, value].sort((a,b) => a-b), startingDpi); }}
            >{t("mouse.stageAdd")}</button>
            <button type="button" className="action-button action-button--secondary action-button--small" disabled={busy}
              onClick={() => { const remaining = stages.filter((n) => n !== selected); onSave(remaining.length ? remaining : undefined, remaining.length ? remaining[0] : startingDpi); }}
            >{stages.length === 1 ? t("mouse.stageClear") : t("mouse.stageRemove")}</button>
          </div>
        </>
      )}
    </div>
  );
}
