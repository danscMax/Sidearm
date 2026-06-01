import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listBundledPresets, normalizeCommandError, readBundledPreset } from "../lib/backend";
import type { PresetInfo } from "../lib/backend";
import { importProfile, isValidProfileExport } from "../lib/config-editing";
import type { ProfileExportData } from "../lib/config-editing";
import type { AppConfig, CommandError } from "../lib/config";
import { CloseButton, ModalShell } from "./shared";

export interface PresetsModalProps {
  onCancel: () => void;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setError: (error: CommandError | null) => void;
  onApplied?: (preset: PresetInfo) => void;
}

/**
 * Shows a grid of bundled profile presets. Clicking a preset reads the
 * bundled JSON file via the backend, passes it through `importProfile`
 * (so all IDs are freshly assigned and refs rewired), and appends the new
 * profile to the current config.
 */
export function PresetsModal({
  onCancel,
  updateDraft,
  setError,
  onApplied,
}: PresetsModalProps) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listBundledPresets()
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(normalizeCommandError(err));
          setPresets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setError]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  async function applyPreset(preset: PresetInfo) {
    setApplying(preset.id);
    try {
      const raw = (await readBundledPreset(preset.id)) as ProfileExportData;
      if (!isValidProfileExport(raw)) {
        setError({
          code: "parse_error",
          message: t("presets.invalidFile", { id: preset.id }),
        });
        return;
      }
      updateDraft((c) => importProfile(c, raw));
      onApplied?.(preset);
      onCancel();
    } catch (err) {
      setError(normalizeCommandError(err));
    } finally {
      setApplying(null);
    }
  }

  return (
    <ModalShell
      onClose={onCancel}
      className="presets-modal"
      dialogRef={containerRef}
      ariaLabelledby="presets-modal-title"
    >
        <div className="presets-modal__header">
          <h3 id="presets-modal-title">{t("presets.title")}</h3>
          <CloseButton onClick={onCancel} ariaLabel={t("common.close")} />
        </div>

        <p className="presets-modal__subtitle">{t("presets.subtitle")}</p>

        <div className="presets-modal__body">
          {presets === null ? (
            <p className="panel__muted">{t("presets.loading")}</p>
          ) : presets.length === 0 ? (
            <p className="panel__muted">{t("presets.empty")}</p>
          ) : (
            <div className="presets-modal__grid">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="presets-modal__card"
                  disabled={applying !== null}
                  onClick={() => void applyPreset(preset)}
                >
                  <span className="presets-modal__card-name">{preset.name}</span>
                  {preset.description ? (
                    <span className="presets-modal__card-desc">{preset.description}</span>
                  ) : null}
                  <span className="presets-modal__card-cta">
                    {applying === preset.id
                      ? t("presets.applying")
                      : t("presets.apply")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
    </ModalShell>
  );
}
