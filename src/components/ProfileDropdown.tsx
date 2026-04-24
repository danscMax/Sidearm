import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Profile } from "../lib/config";

export interface ProfileDropdownProps {
  profiles: Profile[];
  effectiveProfileId: string | null;
  runtimeResolvedProfileName: string | null;
  runtimeStatus: "running" | "stopped" | string;
  onSelectProfile: (id: string) => void;
  onSwitchMode: (mode: "profiles" | "debug" | "settings") => void;
  onContextMenu: (x: number, y: number, profileId: string) => void;
}

/**
 * Sidebar profile dropdown — a custom replacement for the native `<select>`.
 *
 * The native element's popup is rendered by the Windows shell in WebView2,
 * which ignores CSS rules on `option:hover` and always paints a system-grey
 * highlight. A pure-div/button implementation lets us match the app's
 * accent-green hover convention exactly.
 */
export function ProfileDropdown({
  profiles,
  effectiveProfileId,
  runtimeResolvedProfileName,
  runtimeStatus,
  onSelectProfile,
  onSwitchMode,
  onContextMenu,
}: ProfileDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const activeProfile = profiles.find((p) => p.id === effectiveProfileId);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Esc, navigate with arrows.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((idx) => (idx + 1) % profiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((idx) =>
          idx <= 0 ? profiles.length - 1 : idx - 1,
        );
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (focusIndex >= 0 && focusIndex < profiles.length) {
          e.preventDefault();
          onSelectProfile(profiles[focusIndex].id);
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, focusIndex, profiles, onSelectProfile]);

  // When opening, position focus on the currently-active item.
  useEffect(() => {
    if (open) {
      const idx = profiles.findIndex((p) => p.id === effectiveProfileId);
      setFocusIndex(idx >= 0 ? idx : 0);
    }
  }, [open, profiles, effectiveProfileId]);

  return (
    <div className="profile-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="profile-dropdown__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => {
          if (effectiveProfileId) {
            e.preventDefault();
            onContextMenu(e.clientX, e.clientY, effectiveProfileId);
          }
        }}
      >
        <span className="profile-dropdown__value">
          {activeProfile?.name ?? t("sidebar.profileHeader")}
        </span>
        <span
          className={`profile-dropdown__chevron${open ? " profile-dropdown__chevron--open" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {open ? (
        <ul className="profile-dropdown__menu" role="listbox">
          {profiles.map((p, idx) => {
            const active = p.id === effectiveProfileId;
            const focused = idx === focusIndex;
            const runtimeActive =
              runtimeStatus === "running" && runtimeResolvedProfileName === p.name;
            return (
              <li
                key={p.id}
                role="option"
                aria-selected={active}
                className={`profile-dropdown__item${active ? " profile-dropdown__item--active" : ""}${focused ? " profile-dropdown__item--focused" : ""}`}
                onMouseEnter={() => setFocusIndex(idx)}
                onClick={() => {
                  onSelectProfile(p.id);
                  setOpen(false);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  onSwitchMode("settings");
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  onContextMenu(e.clientX, e.clientY, p.id);
                }}
              >
                <span className="profile-dropdown__item-name">{p.name}</span>
                {runtimeActive ? (
                  <span
                    className="profile-dropdown__item-dot"
                    title={t("sidebar.activeRuntime")}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
