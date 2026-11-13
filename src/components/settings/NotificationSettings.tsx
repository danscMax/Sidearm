import { useTranslation } from "react-i18next";
import type {
  AppConfig,
  OsdAnimation,
  OsdFontSize,
  Profile,
  Settings,
} from "../../lib/config";
import { SettingRow, Toggle } from "../shared";
import { PillTrack } from "../PillTrack";
import { CornerPicker } from "./CornerPicker";

export interface NotificationSettingsProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  updateSettings: (patch: Partial<Settings>) => void;
}

/** Notifications tab: OSD master toggle, duration/position/size/animation + live preview. */
export function NotificationSettings({
  activeConfig,
  activeProfile,
  updateSettings,
}: NotificationSettingsProps) {
  const { t } = useTranslation();
  const osd = activeConfig.settings;

  // Re-key the preview bubble so it replays its animation on any visual change.
  const previewKey = `${osd.osdPosition}-${osd.osdFontSize}-${osd.osdAnimation}-${osd.osdDurationMs}`;

  const posVert = osd.osdPosition.startsWith("top") ? "flex-start" : "flex-end";
  const posHoriz =
    osd.osdPosition.endsWith("Left") || osd.osdPosition === "topLeft" || osd.osdPosition === "bottomLeft"
      ? "flex-start"
      : "flex-end";

  const previewFontPx = osd.osdFontSize === "small" ? 11 : osd.osdFontSize === "large" ? 14 : 12;
  const previewAnimClass =
    osd.osdAnimation === "fadeIn"
      ? "osd-preview-bubble--fade"
      : osd.osdAnimation === "none"
        ? "osd-preview-bubble--none"
        : "osd-preview-bubble--slide";

  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <span className="settings-section__title">{t("settings.osdHeader")}</span>
        <div className="settings-section__master">
          <span className="settings-section__master-label">{t("settings.osdEnabled")}</span>
          <Toggle
            checked={osd.osdEnabled}
            onChange={(checked) => updateSettings({ osdEnabled: checked })}
            ariaLabel={t("settings.osdEnabled")}
          />
        </div>
      </div>

      <div
        className={`osd-settings-grid${osd.osdEnabled ? "" : " osd-settings-grid--disabled"}`}
      >
        {/* Live preview: a realistic sample toast reflecting size/position/animation. */}
        <div
          className="osd-preview-area"
          data-vert={posVert}
          data-horiz={posHoriz}
          title={t("settings.osdPreviewHint")}
        >
          <div
            key={previewKey}
            className={`osd-preview-toast ${previewAnimClass}`}
            ref={(el) => {
              if (el) el.style.setProperty("--osd-preview-fs", `${previewFontPx}px`);
            }}
          >
            <span className="osd-preview-toast__label">{t("settings.osdPreviewProfileLabel")}</span>
            <span className="osd-preview-toast__name">{activeProfile?.name ?? t("settings.osdPreviewSampleProfile")}</span>
          </div>
        </div>

        <div>
          <SettingRow title={t("settings.osdActions")} hint={t("settings.osdActionsHelp")}>
            <Toggle
              checked={osd.osdActions ?? false}
              onChange={(checked) => updateSettings({ osdActions: checked })}
              ariaLabel={t("settings.osdActions")}
            />
          </SettingRow>

          <SettingRow title={t("settings.hs2CheatSheet")} hint={t("settings.hs2CheatSheetHelp")}>
            <Toggle
              checked={osd.hs2CheatSheet ?? false}
              onChange={(checked) => updateSettings({ hs2CheatSheet: checked })}
              ariaLabel={t("settings.hs2CheatSheet")}
            />
          </SettingRow>

          <SettingRow title={t("settings.osdDuration")}>
            <PillTrack
              items={[1000, 1500, 2000, 3000, 5000].map((ms) => ({
                key: String(ms),
                label: t("settings.osdDurationSeconds", { seconds: ms / 1000 }),
              }))}
              active={String(osd.osdDurationMs)}
              onSelect={(k) => updateSettings({ osdDurationMs: Number(k) })}
            />
          </SettingRow>

          <SettingRow title={t("settings.osdPosition")}>
            <CornerPicker
              value={osd.osdPosition}
              onSelect={(position) => updateSettings({ osdPosition: position })}
            />
          </SettingRow>

          <SettingRow title={t("settings.osdFontSize")}>
            <PillTrack
              items={[
                { key: "small", label: t("settings.osdFontSmall") },
                { key: "medium", label: t("settings.osdFontMedium") },
                { key: "large", label: t("settings.osdFontLarge") },
              ]}
              active={osd.osdFontSize}
              onSelect={(k) => updateSettings({ osdFontSize: k as OsdFontSize })}
            />
          </SettingRow>

          <SettingRow title={t("settings.osdAnimation")}>
            <PillTrack
              items={[
                { key: "slideIn", label: t("settings.osdAnimSlideIn") },
                { key: "fadeIn", label: t("settings.osdAnimFadeIn") },
                { key: "none", label: t("settings.osdAnimNone") },
              ]}
              active={osd.osdAnimation}
              onSelect={(k) => updateSettings({ osdAnimation: k as OsdAnimation })}
            />
          </SettingRow>
        </div>
      </div>
    </section>
  );
}
