import { startTransition, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppMapping, Profile } from "../lib/config";
import { sortAppMappings } from "../lib/helpers";
import { ExeIcon } from "./ExeIcon";

/** App chips shown under the selected profile before "N more". */
const SHOWN_APPS = 6;

/** The foreground app the runtime recognized last, and where it led. */
export interface RecognizedApp {
  exe: string;
  processPath?: string;
  /** The rule that matched it (none: the profile is the fallback). */
  mappingId?: string;
  profileId?: string;
}

const appName = (exe: string) => exe.replace(/\.exe$/i, "");

/** The profiles as one list, each with the apps that switch to it: the
 *  selected one shows its apps (click edits a rule) and "+ App"; the list
 *  folds away. The recognized app is marked in the list, or — folded, or
 *  on another profile — shown in that profile's row instead of its count. */
export function SidebarProfiles({
  profiles,
  appMappings,
  effectiveProfileId,
  runtimeProfileName,
  recognized,
  allRules,
  onSelect,
  onContextMenu,
  onOpenSettings,
  onEditRule,
  onRuleMenu,
  onAddRule,
  onToggleAllRules,
}: {
  profiles: Profile[];
  appMappings: AppMapping[];
  effectiveProfileId: string | null;
  /** The profile the runtime applies now (null while stopped). */
  runtimeProfileName: string | null;
  /** Null while the runtime is stopped or nothing was recognized yet. */
  recognized: RecognizedApp | null;
  allRules: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (x: number, y: number, profileId: string) => void;
  onOpenSettings: () => void;
  onEditRule: (mappingId: string) => void;
  /** Right-click on an app: the rule's menu (edit, duplicate, move, delete). */
  onRuleMenu: (mappingId: string, x: number, y: number) => void;
  onAddRule: () => void;
  onToggleAllRules: () => void;
}) {
  const { t } = useTranslation();
  // The profile whose full app list is open; other profiles show the short one.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The selected profile's app list folded away.
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="sidebar-profiles">
      <ul className="sidebar-profiles__list">
        {profiles.map((profile) => {
          const selected = profile.id === effectiveProfileId;
          const apps = sortAppMappings(appMappings.filter((mapping) => mapping.profileId === profile.id));
          const expanded = expandedId === profile.id;
          const current = recognized?.profileId === profile.id ? recognized : null;
          const listed = selected && !collapsed;
          // A rule deleted or moved since the capture is not in the list: the row shows it.
          const currentInList = current?.mappingId !== undefined && apps.some((mapping) => mapping.id === current.mappingId);
          // The short list always includes the recognized app.
          const shown = expanded
            ? apps
            : apps.filter((mapping, index) => index < SHOWN_APPS || mapping.id === current?.mappingId);
          return (
            <li
              key={profile.id}
              className={`sidebar-profiles__item${selected ? " sidebar-profiles__item--selected" : ""}${selected && apps.length > 0 ? " sidebar-profiles__item--foldable" : ""}`}
            >
              <button
                type="button"
                className="sidebar-profiles__row"
                aria-current={selected ? "true" : undefined}
                onClick={() => startTransition(() => onSelect(profile.id))}
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
                {current && !(listed && currentInList) ? (
                  <span className="sidebar-profiles__count sidebar-profiles__count--current" title={t("sidebar.recognized")}>
                    <ExeIcon exe={current.exe} processPath={current.processPath} className="sidebar-profiles__icon" />
                    <span className="sidebar-profiles__app-name">{appName(current.exe)}</span>
                  </span>
                ) : (
                  <span className="sidebar-profiles__count">
                    {apps.length > 0 ? t("sidebar.appCount", { count: apps.length }) : t("sidebar.noApps")}
                  </span>
                )}
              </button>
              {selected && apps.length > 0 ? (
                <button
                  type="button"
                  className={`sidebar-profiles__fold${collapsed ? " sidebar-profiles__fold--collapsed" : ""}`}
                  aria-expanded={!collapsed}
                  aria-label={t("sidebar.appsToggle")}
                  title={collapsed ? t("sidebar.appsExpand") : t("sidebar.appsCollapse")}
                  onClick={() => setCollapsed((v) => !v)}
                >
                  <span aria-hidden="true">▾</span>
                </button>
              ) : null}
              {selected && (listed || apps.length === 0) ? (
                <div className="sidebar-profiles__apps">
                  {shown.map((mapping) => {
                    const isCurrent = mapping.id === current?.mappingId;
                    return (
                      <button
                        key={mapping.id}
                        type="button"
                        className={`sidebar-profiles__app${mapping.enabled ? "" : " sidebar-profiles__app--disabled"}${isCurrent ? " sidebar-profiles__app--current" : ""}`}
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => onEditRule(mapping.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onRuleMenu(mapping.id, e.clientX, e.clientY);
                        }}
                        title={isCurrent ? `${t("sidebar.recognized")}: ${mapping.processPath ?? mapping.exe}` : mapping.processPath ?? mapping.exe}
                      >
                        <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="sidebar-profiles__icon" />
                        <span className="sidebar-profiles__app-name">{appName(mapping.exe)}</span>
                      </button>
                    );
                  })}
                  {apps.length > SHOWN_APPS && (expanded || shown.length < apps.length) ? (
                    <button
                      type="button"
                      className="sidebar-profiles__app sidebar-profiles__app--more"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : profile.id)}
                    >
                      {expanded ? t("profile.stripLess") : t("profile.stripMore", { count: apps.length - shown.length })}
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
