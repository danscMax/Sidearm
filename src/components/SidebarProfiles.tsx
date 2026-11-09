import { startTransition, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppMapping, Profile } from "../lib/config";
import { sortAppMappings } from "../lib/helpers";
import { ExeIcon } from "./ExeIcon";

/** App chips shown under the selected profile before "N more". */
const SHOWN_APPS = 6;

/** The profiles as one list, each with the apps that switch to it: the
 *  selected one shows its apps (click edits a rule) and "+ App". */
export function SidebarProfiles({
  profiles,
  appMappings,
  effectiveProfileId,
  runtimeProfileName,
  allRules,
  onSelect,
  onContextMenu,
  onOpenSettings,
  onEditRule,
  onAddRule,
  onToggleAllRules,
}: {
  profiles: Profile[];
  appMappings: AppMapping[];
  effectiveProfileId: string | null;
  /** The profile the runtime applies now (null while stopped). */
  runtimeProfileName: string | null;
  allRules: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (x: number, y: number, profileId: string) => void;
  onOpenSettings: () => void;
  onEditRule: (mappingId: string) => void;
  onAddRule: () => void;
  onToggleAllRules: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="sidebar-profiles">
      <ul className="sidebar-profiles__list">
        {profiles.map((profile) => {
          const selected = profile.id === effectiveProfileId;
          const apps = sortAppMappings(appMappings.filter((mapping) => mapping.profileId === profile.id));
          const shown = expanded ? apps : apps.slice(0, SHOWN_APPS);
          return (
            <li key={profile.id} className={`sidebar-profiles__item${selected ? " sidebar-profiles__item--selected" : ""}`}>
              <button
                type="button"
                className="sidebar-profiles__row"
                aria-current={selected ? "true" : undefined}
                onClick={() => {
                  setExpanded(false);
                  startTransition(() => onSelect(profile.id));
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  onOpenSettings();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(e.clientX, e.clientY, profile.id);
                }}
              >
                <span className="sidebar-profiles__name">{profile.name}</span>
                {runtimeProfileName === profile.name ? (
                  <span className="pill-track__active-dot" title={t("sidebar.activeRuntime")} />
                ) : null}
                <span className="sidebar-profiles__count">
                  {apps.length > 0 ? t("sidebar.appCount", { count: apps.length }) : t("sidebar.noApps")}
                </span>
              </button>
              {selected ? (
                <div className="sidebar-profiles__apps">
                  {shown.map((mapping) => (
                    <button
                      key={mapping.id}
                      type="button"
                      className={`sidebar-profiles__app${mapping.enabled ? "" : " sidebar-profiles__app--disabled"}`}
                      onClick={() => onEditRule(mapping.id)}
                      title={mapping.processPath ?? mapping.exe}
                    >
                      <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="sidebar-profiles__icon" />
                      <span className="sidebar-profiles__app-name">{mapping.exe.replace(/\.exe$/i, "")}</span>
                    </button>
                  ))}
                  {apps.length > SHOWN_APPS ? (
                    <button
                      type="button"
                      className="sidebar-profiles__app sidebar-profiles__app--more"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? t("profile.stripLess") : t("profile.stripMore", { count: apps.length - SHOWN_APPS })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="sidebar-profiles__app sidebar-profiles__app--add"
                    onClick={onAddRule}
                    title={t("profile.addRuleTooltip")}
                  >
                    {t("profile.stripAddApp")}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`action-button action-button--small sidebar-profiles__all${allRules ? " action-button--active" : ""}`}
        aria-pressed={allRules}
        onClick={onToggleAllRules}
      >
        {t("profile.allProfilesToggle")}
      </button>
    </div>
  );
}
