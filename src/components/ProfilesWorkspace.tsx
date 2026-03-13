import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppConfig, Profile } from "../lib/config";
import type { ViewState } from "../lib/constants";
import type { WindowCaptureResult } from "../lib/runtime";
import {
  createAppMappingFromCapture,
  deleteAppMapping,
  deleteProfile,
  findDuplicateAppMapping,
  upsertAppMapping,
  upsertProfile,
} from "../lib/config-editing";
import { parseCommaSeparatedUniqueValues, sortAppMappings } from "../lib/helpers";

export interface ProfilesWorkspaceProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  profiles: Profile[];
  effectiveProfileId: string | null;
  lastCapture: WindowCaptureResult | null;
  captureDelayMs: number;
  viewState: ViewState;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setCaptureDelayMs: (ms: number) => void;
  setSelectedProfileId: (id: string | null) => void;
  setConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null) => void;
  handleCaptureActiveWindow: () => Promise<void>;
}

/** First 2 uppercase letters of exe name (sans extension) for monogram icon. */
function exeMonogram(exe: string): string {
  const base = exe.replace(/\.exe$/i, "");
  return base.slice(0, 2).toUpperCase();
}

export function ProfilesWorkspace({
  activeConfig,
  activeProfile,
  profiles,
  effectiveProfileId,
  lastCapture,
  captureDelayMs,
  viewState,
  updateDraft,
  setCaptureDelayMs,
  setSelectedProfileId,
  setConfirmModal,
  handleCaptureActiveWindow,
}: ProfilesWorkspaceProps) {
  const [selectedAppMappingId, setSelectedAppMappingId] = useState<string | null>(null);
  const [includeTitleFilter, setIncludeTitleFilter] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedAppMappings = useMemo(
    () =>
      effectiveProfileId
        ? sortAppMappings(
            activeConfig.appMappings.filter(
              (mapping) => mapping.profileId === effectiveProfileId,
            ),
          )
        : [],
    [activeConfig.appMappings, effectiveProfileId],
  );
  const selectedAppMapping =
    selectedAppMappings.find((mapping) => mapping.id === selectedAppMappingId) ?? null;

  useEffect(() => {
    if (!effectiveProfileId) return;
    if (
      selectedAppMappingId === null ||
      !selectedAppMappings.some((mapping) => mapping.id === selectedAppMappingId)
    ) {
      startTransition(() => {
        setSelectedAppMappingId(selectedAppMappings[0]?.id ?? null);
      });
    }
  }, [effectiveProfileId, selectedAppMappingId, selectedAppMappings]);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  async function handleCaptureWithCountdown() {
    const totalMs = captureDelayMs;
    const startTime = Date.now();
    setCaptureCountdown(Math.ceil(totalMs / 1000));

    countdownRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setCaptureCountdown(remaining);
      if (remaining <= 0 && countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    }, 200);

    try {
      await handleCaptureActiveWindow();
    } finally {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      setCaptureCountdown(null);
    }
  }

  function handleCreateRule(exe: string, title: string, withTitleFilter: boolean) {
    if (!activeProfile) return;
    const duplicate = findDuplicateAppMapping(activeConfig, activeProfile.id, exe);
    if (duplicate) {
      setConfirmModal({
        title: "Правило уже существует",
        message: `Для «${duplicate.exe}» уже есть правило в этом профиле. Создать ещё одно?`,
        confirmLabel: "Создать",
        onConfirm: () => {
          doCreateRule(exe, title, withTitleFilter);
          setConfirmModal(null);
        },
      });
      return;
    }
    doCreateRule(exe, title, withTitleFilter);
  }

  function doCreateRule(exe: string, title: string, withTitleFilter: boolean) {
    if (!activeProfile) return;
    let newId: string | null = null;
    updateDraft((config) => {
      const result = createAppMappingFromCapture(
        config,
        activeProfile.id,
        activeProfile.priority,
        exe,
        title,
        withTitleFilter,
      );
      newId = result.newMappingId;
      return result.config;
    });
    if (newId) {
      startTransition(() => setSelectedAppMappingId(newId));
    }
  }

  const captureMatchInfo = useMemo(() => {
    if (!lastCapture || lastCapture.ignored) return null;
    if (lastCapture.resolvedProfileName) {
      return `Совпадает с профилем «${lastCapture.resolvedProfileName}»`;
    }
    return null;
  }, [lastCapture]);

  const hasCapture = lastCapture && !lastCapture.ignored;

  return (
    <div className="workspace__left">
      {/* ── Profile settings ── */}
      <section className="panel">
        <p className="panel__eyebrow">Параметры профиля</p>
        {activeProfile ? (
          <div className="editor-grid">
            <label className="field">
              <span className="field__label">Имя</span>
              <input
                type="text"
                value={activeProfile.name}
                onChange={(e) =>
                  updateDraft((c) => upsertProfile(c, { ...activeProfile, name: e.target.value }))
                }
                onBlur={(e) => {
                  if (!e.target.value.trim())
                    updateDraft((c) => upsertProfile(c, { ...activeProfile, name: "Безымянный профиль" }));
                }}
              />
            </label>

            <label className="field">
              <span className="field__label">Описание</span>
              <textarea
                rows={2}
                value={activeProfile.description ?? ""}
                onChange={(e) =>
                  updateDraft((c) =>
                    upsertProfile(c, { ...activeProfile, description: e.target.value || undefined }),
                  )
                }
              />
            </label>

            <div className="profiles__settings-row">
              <label className="field field--inline profiles__field-no-margin">
                <span className="field__label">Включён</span>
                <input
                  className="profiles__toggle"
                  type="checkbox"
                  checked={activeProfile.enabled}
                  onChange={(e) =>
                    updateDraft((c) => upsertProfile(c, { ...activeProfile, enabled: e.target.checked }))
                  }
                />
              </label>

              <label className="field field--inline profiles__priority-field">
                <span className="field__label">
                  Приоритет
                  <span className="field__hint" title="Чем выше число, тем предпочтительнее профиль при конфликте">?</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={activeProfile.priority}
                  className="profiles__priority-input"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const clamped = Number.isFinite(v) ? Math.max(0, Math.min(9999, Math.round(v))) : 0;
                    updateDraft((c) => upsertProfile(c, { ...activeProfile, priority: clamped }));
                  }}
                />
              </label>

              {profiles.length > 1 ? (
                <button
                  type="button"
                  className="action-button action-button--ghost profiles__delete-btn"
                  onClick={() => {
                    setConfirmModal({
                      title: "Удалить профиль?",
                      message: `Профиль «${activeProfile.name}» будет удалён вместе со всеми назначениями и правилами.`,
                      confirmLabel: "Удалить",
                      onConfirm: () => {
                        updateDraft((c) => deleteProfile(c, activeProfile.id));
                        setSelectedProfileId(null);
                        setConfirmModal(null);
                      },
                    });
                  }}
                >
                  Удалить профиль
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="panel__muted">Профиль не выбран.</p>
        )}
      </section>

      {/* ── App rules ── */}
      <section className="panel">
        <p className="panel__eyebrow">Правила для приложений</p>

        {/* Capture widget */}
        <div className="profiles__capture-widget">
          <div className="profiles__capture-header">
            <strong>Захват окна</strong>
            <div className="profiles__capture-controls">
              <select
                className="profiles__capture-delay"
                value={captureDelayMs}
                onChange={(e) => setCaptureDelayMs(Number(e.target.value))}
              >
                <option value={500}>0.5с</option>
                <option value={1000}>1с</option>
                <option value={1500}>1.5с</option>
                <option value={2000}>2с</option>
                <option value={3000}>3с</option>
                <option value={5000}>5с</option>
              </select>
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => { void handleCaptureWithCountdown(); }}
                disabled={viewState === "loading" || viewState === "saving" || captureCountdown !== null}
              >
                {captureCountdown !== null ? `${captureCountdown}…` : "Захватить"}
              </button>
            </div>
          </div>
          {hasCapture ? (
            <div>
              <div className="profiles__capture-result">
                <span>
                  <span className="profiles__capture-exe">{lastCapture.exe}</span>
                  <span className="profiles__capture-title">
                    {lastCapture.title || "(без заголовка)"}
                  </span>
                </span>
              </div>
              {captureMatchInfo ? (
                <span className="profiles__capture-match">{captureMatchInfo}</span>
              ) : null}
              {/* Create from capture */}
              {activeProfile ? (
                <div className="profiles__capture-actions">
                  <button
                    type="button"
                    className="action-button action-button--small action-button--accent"
                    onClick={() => handleCreateRule(lastCapture.exe, lastCapture.title, includeTitleFilter)}
                  >
                    Создать правило
                  </button>
                  <label className="profiles__capture-filter-label">
                    <input
                      type="checkbox"
                      checked={includeTitleFilter}
                      onChange={(e) => setIncludeTitleFilter(e.target.checked)}
                    />
                    с фильтром заголовка
                  </label>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="panel__muted">
              Переключитесь на нужное окно и нажмите «Захватить».
            </p>
          )}
        </div>

        {/* Rule list */}
        {selectedAppMappings.length > 0 ? (
          <div className="route-list profiles__rule-list">
            {selectedAppMappings.map((mapping) => {
              const isActive = selectedAppMapping?.id === mapping.id;
              const isDisabled = !mapping.enabled;
              return (
                <button
                  key={mapping.id}
                  type="button"
                  className={`card profiles__rule-card${isActive ? " profiles__rule-card--active" : ""}${isDisabled ? " profiles__rule-card--disabled" : ""}`}
                  onClick={() => setSelectedAppMappingId(mapping.id)}
                >
                  <input
                    className="profiles__toggle"
                    type="checkbox"
                    checked={mapping.enabled}
                    title={mapping.enabled ? "Отключить" : "Включить"}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      updateDraft((c) => upsertAppMapping(c, { ...mapping, enabled: e.target.checked }))
                    }
                  />
                  <span className="profiles__monogram">{exeMonogram(mapping.exe)}</span>
                  <span className="profiles__rule-info">
                    <span className="profiles__rule-exe">{mapping.exe}</span>
                    {mapping.titleIncludes && mapping.titleIncludes.length > 0 ? (
                      <span className="profiles__rule-title-filter">
                        {mapping.titleIncludes.join(", ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="badge badge--muted profiles__rule-priority">
                    {mapping.priority}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Add rule button */}
        {activeProfile ? (
          <button
            type="button"
            className="action-button action-button--ghost profiles__add-rule-btn"
            onClick={() => handleCreateRule("example.exe", "", false)}
          >
            + Добавить правило вручную
          </button>
        ) : null}

        {/* ── Selected rule editor ── */}
        {selectedAppMapping ? (
          <div className="profiles__rule-editor">
            <div className="profiles__rule-editor-header">
              <span className="profiles__monogram">{exeMonogram(selectedAppMapping.exe)}</span>
              <span className="profiles__rule-editor-title">{selectedAppMapping.exe}</span>
            </div>

            <div className="profiles__rule-editor-body">
              <div className="field">
                <span className="field__label">Исполняемый файл</span>
                <div className="field__row">
                  <input
                    type="text"
                    value={selectedAppMapping.exe}
                    placeholder="example.exe"
                    onChange={(e) =>
                      updateDraft((c) => upsertAppMapping(c, { ...selectedAppMapping, exe: e.target.value }))
                    }
                    onBlur={(e) => {
                      if (!e.target.value.trim())
                        updateDraft((c) => upsertAppMapping(c, { ...selectedAppMapping, exe: "example.exe" }));
                    }}
                  />
                  <button
                    type="button"
                    className="action-button action-button--small"
                    onClick={async () => {
                      const selected = await open({
                        title: "Выберите исполняемый файл",
                        filters: [{ name: "Программы", extensions: ["exe", "lnk"] }],
                        multiple: false,
                      });
                      if (typeof selected === "string") {
                        const exeName = selected.split(/[/\\]/).pop() ?? selected;
                        updateDraft((c) =>
                          upsertAppMapping(c, { ...selectedAppMapping, exe: exeName.toLowerCase() }),
                        );
                      }
                    }}
                  >
                    Обзор…
                  </button>
                </div>
              </div>

              <label className="field">
                <span className="field__label">
                  Фильтры заголовка
                  <span className="field__hint" title="Через запятую. Правило сработает, только если заголовок содержит ВСЕ фрагменты.">?</span>
                </span>
                <input
                  type="text"
                  defaultValue={(selectedAppMapping.titleIncludes ?? []).join(", ")}
                  key={selectedAppMapping.id}
                  placeholder="часть заголовка, ещё часть"
                  onBlur={(e) => {
                    const vals = parseCommaSeparatedUniqueValues(e.target.value);
                    updateDraft((c) =>
                      upsertAppMapping(c, {
                        ...selectedAppMapping,
                        titleIncludes: vals.length > 0 ? vals : undefined,
                      }),
                    );
                  }}
                />
              </label>

              <div className="profiles__rule-editor-row">
                <label className="field field--inline profiles__field-no-margin">
                  <span className="field__label">Включено</span>
                  <input
                    className="profiles__toggle"
                    type="checkbox"
                    checked={selectedAppMapping.enabled}
                    onChange={(e) =>
                      updateDraft((c) =>
                        upsertAppMapping(c, { ...selectedAppMapping, enabled: e.target.checked }),
                      )
                    }
                  />
                </label>

                <label className="field field--inline profiles__field-no-margin">
                  <span className="field__label">Приоритет</span>
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={selectedAppMapping.priority}
                    className="profiles__priority-input"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const clamped = Number.isFinite(v) ? Math.max(0, Math.min(9999, Math.round(v))) : 0;
                      updateDraft((c) =>
                        upsertAppMapping(c, { ...selectedAppMapping, priority: clamped }),
                      );
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="profiles__rule-editor-footer">
              {hasCapture ? (
                <button
                  type="button"
                  className="action-button action-button--small action-button--secondary"
                  onClick={() =>
                    updateDraft((c) =>
                      upsertAppMapping(c, {
                        ...selectedAppMapping,
                        exe: lastCapture.exe,
                        titleIncludes: lastCapture.title ? [lastCapture.title] : undefined,
                      }),
                    )
                  }
                >
                  Подставить из захвата
                </button>
              ) : null}

              <span className="profiles__spacer" />

              <button
                type="button"
                className="action-button action-button--ghost profiles__delete-btn"
                onClick={() => {
                  setConfirmModal({
                    title: "Удалить правило?",
                    message: `Правило для «${selectedAppMapping.exe}» будет удалено.`,
                    confirmLabel: "Удалить",
                    onConfirm: () => {
                      updateDraft((c) => deleteAppMapping(c, selectedAppMapping.id));
                      setSelectedAppMappingId(null);
                      setConfirmModal(null);
                    },
                  });
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ) : selectedAppMappings.length === 0 ? (
          <p className="panel__muted profiles__empty-hint">
            Правил пока нет. Захватите окно или добавьте вручную.
          </p>
        ) : null}
      </section>
    </div>
  );
}
