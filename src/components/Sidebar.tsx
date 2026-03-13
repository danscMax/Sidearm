import { startTransition } from "react";
import type { WorkspaceMode, ViewState } from "../lib/constants";
import { workspaceModeCopy } from "../lib/constants";
import { stateLabel } from "../lib/helpers";

interface Profile {
  id: string;
  name: string;
}

export function Sidebar({
  workspaceMode,
  onSwitchMode,
  profiles,
  effectiveProfileId,
  runtimeResolvedProfileName,
  onSelectProfile,
  isProfilesMode,
  onCreateProfile,
  onToggleRuntime,
  runtimeStatus,
  viewState,
}: {
  workspaceMode: WorkspaceMode;
  onSwitchMode: (mode: WorkspaceMode) => void;
  profiles: Profile[];
  effectiveProfileId: string | null;
  runtimeResolvedProfileName: string | null;
  onSelectProfile: (id: string) => void;
  isProfilesMode: boolean;
  onCreateProfile: () => void;
  onToggleRuntime: () => void;
  runtimeStatus: "running" | "stopped" | string;
  viewState: ViewState;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        Naga Studio
        <strong>Razer Naga V2 HyperSpeed</strong>
      </div>
      {workspaceModeCopy.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={`nav-item${workspaceMode === mode.value ? " nav-item--active" : ""}`}
          onClick={() => { onSwitchMode(mode.value); }}
        >
          {mode.label}
        </button>
      ))}
      <div className="sidebar__sep" />
      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-label">Профиль</span>
          {isProfilesMode ? (
            <button
              type="button"
              className="sidebar__add-profile-btn"
              onClick={onCreateProfile}
              title="Добавить профиль"
            >
              +
            </button>
          ) : null}
        </div>
        <select
          className="sidebar__profile-select"
          value={effectiveProfileId ?? ""}
          onChange={(event) => {
            startTransition(() => {
              onSelectProfile(event.target.value);
            });
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {runtimeStatus === "running" && runtimeResolvedProfileName ? (
          <div className="sidebar__runtime-profile" title="Последний профиль, выбранный перехватчиком по активному окну">
            Активный: {runtimeResolvedProfileName}
          </div>
        ) : null}
      </div>
      <button
        className={`sidebar__runtime sidebar__runtime--${runtimeStatus === "running" ? "running" : "stopped"}`}
        onClick={onToggleRuntime}
        type="button"
      >
        <span className={`sidebar__runtime-dot sidebar__runtime-dot--${runtimeStatus === "running" ? "running" : "stopped"}`} />
        <span className="sidebar__runtime-label">
          {runtimeStatus === "running" ? "Перехват активен" : "Перехват остановлен"}
        </span>
        <span className="sidebar__runtime-action">
          {runtimeStatus === "running" ? "Стоп" : "Старт"}
        </span>
      </button>
      <div className={`sidebar__status${viewState === "error" ? " sidebar__status--error" : ""}`} aria-live="polite">
        {viewState === "error"
          ? "Ошибка сохранения"
          : stateLabel(viewState)}
      </div>
    </aside>
  );
}
