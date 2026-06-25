import { useTranslation } from "react-i18next";

import { PillTrack } from "./PillTrack";

interface CaptureControlsProps {
  /** Live countdown (seconds) while a capture is pending; `null` when idle. */
  countdown: number | null;
  /** Selected capture delay in milliseconds. */
  delayMs: number;
  onSelectDelay: (ms: number) => void;
  /** Trigger an active-window capture. */
  onCapture: () => void;
  /** Report an exe basename dropped onto the dropzone (`.lnk` is mapped to `.exe`). */
  onDropExe: (exeName: string) => void;
  /** Disable the capture trigger (e.g. while loading/saving or mid-countdown). */
  disabled?: boolean;
}

/**
 * Active-window capture block shared by the rule card: a drag-drop target for an
 * `.exe`/shortcut, a capture button with a live countdown, and a delay selector.
 * Presentational — the runtime capture machinery (countdown timer, foreground
 * read) lives in the workspace and is wired through the props.
 */
export function CaptureControls({
  countdown,
  delayMs,
  onSelectDelay,
  onCapture,
  onDropExe,
  disabled,
}: CaptureControlsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div
        className="new-rule__dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).classList.add("new-rule__dropzone--active");
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            (e.currentTarget as HTMLElement).classList.remove("new-rule__dropzone--active");
          }
        }}
        onDrop={(e) => {
          (e.currentTarget as HTMLElement).classList.remove("new-rule__dropzone--active");
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) {
            const name = file.name.replace(/\.lnk$/i, ".exe").toLowerCase();
            if (name.endsWith(".exe")) onDropExe(name);
          }
        }}
      >
        <svg className="new-rule__dropzone-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>{t("newRule.dropzone")}</span>
      </div>

      <div className="new-rule__divider">{t("newRule.divider")}</div>

      <div className="new-rule__capture">
        <button
          type="button"
          className="action-button action-button--accent new-rule__capture-btn"
          onClick={onCapture}
          disabled={disabled}
        >
          {countdown !== null
            ? t("newRule.captureCountdown", { countdown })
            : t("newRule.captureButton")}
        </button>
        <div className="new-rule__delay-row">
          <span className="new-rule__delay-label">{t("newRule.delayLabel")}</span>
          <PillTrack
            items={[1000, 2000, 3000, 5000].map((ms) => ({
              key: String(ms),
              label: `${ms / 1000}${t("common.secondsShort")}`,
            }))}
            active={String(delayMs)}
            onSelect={(k) => onSelectDelay(Number(k))}
          />
        </div>
        <p className="new-rule__capture-hint">{t("newRule.captureHelp")}</p>
      </div>
    </>
  );
}
