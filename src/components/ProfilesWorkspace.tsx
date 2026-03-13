import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppConfig, AppMapping, Binding, ControlId, Layer, Profile } from "../lib/config";
import type { FamilySection, ViewState } from "../lib/constants";
import type { WindowCaptureResult } from "../lib/runtime";
import {
  createAppMappingFromCapture,
  deleteAppMapping,
  deleteProfile,
  duplicateProfile,
  ensurePlaceholderBinding,
  findDuplicateAppMapping,
  makeBindingId,
  upsertAppMapping,
  upsertProfile,
} from "../lib/config-editing";
import { getExeIcon } from "../lib/backend";
import { parseCommaSeparatedUniqueValues, sortAppMappings } from "../lib/helpers";
import { MouseVisualization } from "./MouseVisualization";

/** Module-level icon cache: exe name -> base64 PNG (or empty string for "no icon"). */
const exeIconCache = new Map<string, string>();

/** Pending fetch promises to avoid duplicate concurrent requests. */
const exeIconPending = new Map<string, Promise<string | null>>();

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
  familySections: FamilySection[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectLayer: (layer: Layer) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
}

/** First 2 uppercase letters of exe name (sans extension) for monogram icon. */
function exeMonogram(exe: string): string {
  const base = exe.replace(/\.exe$/i, "");
  return base.slice(0, 2).toUpperCase();
}

/** First letter of profile name for avatar monogram. */
function profileMonogram(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

/** Renders an exe icon (fetched from backend) with monogram fallback. */
function ExeIcon({ exe, className }: { exe: string; className: string }) {
  const [iconSrc, setIconSrc] = useState<string | null>(() => {
    const cached = exeIconCache.get(exe);
    return cached ? `data:image/png;base64,${cached}` : null;
  });

  useEffect(() => {
    if (exeIconCache.has(exe)) {
      const v = exeIconCache.get(exe)!;
      setIconSrc(v ? `data:image/png;base64,${v}` : null);
      return;
    }

    let cancelled = false;
    let pending = exeIconPending.get(exe);
    if (!pending) {
      pending = getExeIcon(exe);
      exeIconPending.set(exe, pending);
    }
    pending.then((b64) => {
      exeIconCache.set(exe, b64 ?? "");
      exeIconPending.delete(exe);
      if (!cancelled && b64) {
        setIconSrc(`data:image/png;base64,${b64}`);
      }
    }).catch(() => {
      exeIconCache.set(exe, "");
      exeIconPending.delete(exe);
    });
    return () => { cancelled = true; };
  }, [exe]);

  if (iconSrc) {
    return <img className={className} src={iconSrc} alt={exe} draggable={false} />;
  }
  return <span className={className}>{exeMonogram(exe)}</span>;
}

/* ────────────────────────────────────────────────────────────
   App Mapping Modal
   ──────────────────────────────────────────────────────────── */

interface AppMappingModalProps {
  mapping: AppMapping;
  lastCapture: WindowCaptureResult | null;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  onClose: () => void;
  setConfirmModal: ProfilesWorkspaceProps["setConfirmModal"];
}

function AppMappingModal({
  mapping,
  lastCapture,
  updateDraft,
  onClose,
  setConfirmModal,
}: AppMappingModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasCapture = lastCapture && !lastCapture.ignored;

  // Escape key closes the modal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Auto-focus the modal container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Focus trap: keep Tab within the modal
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;

    const focusable = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="rule-modal"
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Правило: ${mapping.exe}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="rule-modal__header">
          <ExeIcon exe={mapping.exe} className="profiles__app-card-monogram" />
          <span className="rule-modal__title">{mapping.exe}</span>
          <button
            type="button"
            className="rule-modal__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="rule-modal__body">
          {/* Capture suggestion banner */}
          {hasCapture ? (
            <div className="rule-modal__capture-banner">
              <div className="rule-modal__capture-info">
                <span className="profiles__capture-exe">{lastCapture.exe}</span>
                <span className="profiles__capture-title">
                  {lastCapture.title || "(без заголовка)"}
                </span>
              </div>
              <button
                type="button"
                className="action-button action-button--small action-button--accent"
                onClick={() =>
                  updateDraft((c) =>
                    upsertAppMapping(c, {
                      ...mapping,
                      exe: lastCapture.exe,
                      titleIncludes: lastCapture.title ? [lastCapture.title] : undefined,
                    }),
                  )
                }
              >
                Подставить
              </button>
            </div>
          ) : null}

          {/* Exe input + Browse */}
          <div className="field">
            <span className="field__label">Исполняемый файл</span>
            <div className="field__row">
              <input
                type="text"
                value={mapping.exe}
                placeholder="example.exe"
                onChange={(e) =>
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, exe: e.target.value }))
                }
                onBlur={(e) => {
                  if (!e.target.value.trim())
                    updateDraft((c) => upsertAppMapping(c, { ...mapping, exe: "example.exe" }));
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
                      upsertAppMapping(c, { ...mapping, exe: exeName.toLowerCase() }),
                    );
                  }
                }}
              >
                Обзор...
              </button>
            </div>
          </div>

          {/* Title filters */}
          <label className="field">
            <span className="field__label">
              Фильтры заголовка
              <span
                className="field__hint"
                title="Через запятую. Правило сработает, только если заголовок содержит ВСЕ фрагменты."
              >
                ?
              </span>
            </span>
            <input
              type="text"
              defaultValue={(mapping.titleIncludes ?? []).join(", ")}
              key={mapping.id}
              placeholder="часть заголовка, ещё часть"
              onBlur={(e) => {
                const vals = parseCommaSeparatedUniqueValues(e.target.value);
                updateDraft((c) =>
                  upsertAppMapping(c, {
                    ...mapping,
                    titleIncludes: vals.length > 0 ? vals : undefined,
                  }),
                );
              }}
            />
          </label>

          {/* Toggle + Priority row */}
          <div className="rule-modal__inline-row">
            <label className="field field--inline profiles__field-no-margin">
              <span className="field__label">Включено</span>
              <input
                className="profiles__toggle"
                type="checkbox"
                checked={mapping.enabled}
                onChange={(e) =>
                  updateDraft((c) =>
                    upsertAppMapping(c, { ...mapping, enabled: e.target.checked }),
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
                value={mapping.priority}
                className="profiles__priority-input"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v)
                    ? Math.max(0, Math.min(9999, Math.round(v)))
                    : 0;
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, priority: clamped }));
                }}
              />
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="rule-modal__footer">
          <span className="rule-modal__spacer" />

          <button
            type="button"
            className="action-button action-button--ghost profiles__delete-btn"
            onClick={() => {
              setConfirmModal({
                title: "Удалить правило?",
                message: `Правило для «${mapping.exe}» будет удалено.`,
                confirmLabel: "Удалить",
                onConfirm: () => {
                  updateDraft((c) => deleteAppMapping(c, mapping.id));
                  onClose();
                  setConfirmModal(null);
                },
              });
            }}
          >
            Удалить правило
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Profiles Workspace
   ──────────────────────────────────────────────────────────── */

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
  familySections,
  selectedLayer,
  multiSelectedControlIds,
  onSelectLayer,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
}: ProfilesWorkspaceProps) {
  const [editingMappingId, setEditingMappingId] = useState<string | null>(null);
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

  const editingMapping =
    selectedAppMappings.find((mapping) => mapping.id === editingMappingId) ?? null;

  // Clear editing id if it no longer exists
  useEffect(() => {
    if (editingMappingId && !selectedAppMappings.some((m) => m.id === editingMappingId)) {
      startTransition(() => setEditingMappingId(null));
    }
  }, [editingMappingId, selectedAppMappings]);

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
      startTransition(() => setEditingMappingId(newId));
    }
  }

  function handleDuplicateProfile() {
    if (!activeProfile) return;
    let newProfileId: string | null = null;
    updateDraft((config) => {
      const result = duplicateProfile(config, activeProfile.id);
      newProfileId = result.newProfileId;
      return result.config;
    });
    if (newProfileId) {
      startTransition(() => setSelectedProfileId(newProfileId));
    }
  }

  function handleExportProfile() {
    if (!activeProfile) return;

    // Collect profile data
    const profileAppMappings = activeConfig.appMappings.filter(
      (m) => m.profileId === activeProfile.id,
    );
    const profileBindings = activeConfig.bindings.filter(
      (b) => b.profileId === activeProfile.id,
    );
    const referencedActionIds = new Set(profileBindings.map((b) => b.actionRef));
    // Include nested menu action refs
    for (const actionId of referencedActionIds) {
      const action = activeConfig.actions.find((a) => a.id === actionId);
      if (action?.type === "menu") {
        collectMenuActionRefs(action.payload.items, referencedActionIds);
      }
    }
    const profileActions = activeConfig.actions.filter((a) => referencedActionIds.has(a.id));

    const exportData = {
      profile: activeProfile,
      appMappings: profileAppMappings,
      bindings: profileBindings,
      actions: profileActions,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeProfile.name.replace(/[^a-zA-Z0-9а-яА-Я_-]/g, "_")}.profile.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const hasCapture = lastCapture && !lastCapture.ignored;

  const useToggleSelector = profiles.length <= 6;
  const selectedIndex = profiles.findIndex((p) => p.id === effectiveProfileId);

  function handleOpenActionPicker(controlId: ControlId, binding: Binding | null) {
    if (!effectiveProfileId) return;
    if (binding) {
      setActionPickerBindingId(binding.id);
      setActionPickerOpen(true);
      return;
    }
    updateDraft((config) => {
      const control = config.physicalControls.find((c) => c.id === controlId);
      if (!control) return config;
      return ensurePlaceholderBinding(config, effectiveProfileId, selectedLayer, control);
    });
    const bindingId = makeBindingId(effectiveProfileId, selectedLayer, controlId);
    setActionPickerBindingId(bindingId);
    setActionPickerOpen(true);
  }

  return (
    <div className="profiles-workspace">
      {/* ── Profile selector ── */}
      {useToggleSelector ? (
        <div className="profile-selector">
          <div
            className="profile-selector__track"
            style={{ "--pill-count": profiles.length } as React.CSSProperties}
          >
            {selectedIndex >= 0 ? (
              <div
                className="profile-selector__indicator"
                style={{ transform: `translateX(${selectedIndex * 100}%)` }}
              />
            ) : null}
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`profile-selector__pill${p.id === effectiveProfileId ? " profile-selector__pill--active" : ""}`}
                onClick={() => {
                  startTransition(() => setSelectedProfileId(p.id));
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <select
          className="profile-selector__dropdown"
          value={effectiveProfileId ?? ""}
          onChange={(e) => {
            startTransition(() => setSelectedProfileId(e.target.value));
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      {/* ── Mouse visualization ── */}
      <div className="profiles__mouse-viz">
        <MouseVisualization
          entries={familySections.flatMap((section) => section.entries)}
          selectedLayer={selectedLayer}
          multiSelectedControlIds={multiSelectedControlIds}
          onSelectControl={(id) => {
            startTransition(() => {
              setSelectedControlId(id);
              setMultiSelectedControlIds(new Set());
            });
          }}
          onToggleMultiSelect={(id) => {
            setMultiSelectedControlIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onOpenActionPicker={handleOpenActionPicker}
          onSelectLayer={onSelectLayer}
        />
      </div>

      {/* ── Profile banner ── */}
      {activeProfile ? (
        <div className="profiles__banner">
          <div className="profiles__banner-row1">
            <span className="profiles__banner-avatar">{profileMonogram(activeProfile.name)}</span>

            <input
              type="text"
              className="profiles__banner-name"
              value={activeProfile.name}
              onChange={(e) =>
                updateDraft((c) => upsertProfile(c, { ...activeProfile, name: e.target.value }))
              }
              onBlur={(e) => {
                if (!e.target.value.trim())
                  updateDraft((c) =>
                    upsertProfile(c, { ...activeProfile, name: "Безымянный профиль" }),
                  );
              }}
            />

            <label className="profiles__banner-toggle-label">
              <input
                className="profiles__toggle"
                type="checkbox"
                checked={activeProfile.enabled}
                onChange={(e) =>
                  updateDraft((c) =>
                    upsertProfile(c, { ...activeProfile, enabled: e.target.checked }),
                  )
                }
              />
            </label>

            <label className="profiles__banner-priority">
              <span>P</span>
              <input
                type="number"
                min={0}
                max={9999}
                value={activeProfile.priority}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v)
                    ? Math.max(0, Math.min(9999, Math.round(v)))
                    : 0;
                  updateDraft((c) => upsertProfile(c, { ...activeProfile, priority: clamped }));
                }}
              />
            </label>

            <div className="profiles__banner-actions">
              <button
                type="button"
                className="profiles__banner-action-btn"
                onClick={handleDuplicateProfile}
                title="Копировать профиль"
              >
                Копировать
              </button>
              <button
                type="button"
                className="profiles__banner-action-btn"
                onClick={handleExportProfile}
                title="Экспорт профиля"
              >
                Экспорт
              </button>
              {profiles.length > 1 ? (
                <button
                  type="button"
                  className="profiles__banner-action-btn profiles__banner-action-btn--danger"
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
                  Удалить
                </button>
              ) : null}
            </div>
          </div>

          <input
            type="text"
            className="profiles__banner-desc"
            value={activeProfile.description ?? ""}
            placeholder="Описание профиля..."
            onChange={(e) =>
              updateDraft((c) =>
                upsertProfile(c, {
                  ...activeProfile,
                  description: e.target.value || undefined,
                }),
              )
            }
          />
        </div>
      ) : (
        <div className="profiles__banner profiles__banner--empty">
          <span className="profiles__banner-avatar">?</span>
          <span className="profiles__banner-name-placeholder">Профиль не выбран</span>
        </div>
      )}

      {/* ── Capture bar (pure tool — no creation buttons) ── */}
      <div className="profiles__capture-bar">
        <div className="profiles__capture-bar-left">
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
            onClick={() => {
              void handleCaptureWithCountdown();
            }}
            disabled={
              viewState === "loading" || viewState === "saving" || captureCountdown !== null
            }
          >
            {captureCountdown !== null ? `${captureCountdown}...` : "Захватить окно"}
          </button>
        </div>

        {hasCapture ? (
          <div className="profiles__capture-bar-right">
            <span className="profiles__capture-bar-result">
              <span className="profiles__capture-exe">{lastCapture.exe}</span>
              <span className="profiles__capture-title">
                {lastCapture.title || "(без заголовка)"}
              </span>
            </span>
          </div>
        ) : (
          <span className="profiles__capture-bar-hint">
            Переключитесь на нужное окно и нажмите «Захватить»
          </span>
        )}
      </div>

      {/* ── Section header ── */}
      <div className="profiles__section-header">
        <span>ПРАВИЛА ДЛЯ ПРИЛОЖЕНИЙ</span>
        <span className="profiles__section-count">{selectedAppMappings.length}</span>
      </div>

      {/* ── Card grid ── */}
      <div className="profiles__card-grid">
        {selectedAppMappings.map((mapping) => {
          const isActive = editingMapping?.id === mapping.id;
          const isDisabled = !mapping.enabled;
          return (
            <button
              key={mapping.id}
              type="button"
              className={`profiles__app-card${isActive ? " profiles__app-card--active" : ""}${isDisabled ? " profiles__app-card--disabled" : ""}`}
              onClick={() => setEditingMappingId(mapping.id)}
            >
              <input
                className="profiles__app-card-toggle profiles__toggle"
                type="checkbox"
                checked={mapping.enabled}
                title={mapping.enabled ? "Отключить" : "Включить"}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  updateDraft((c) =>
                    upsertAppMapping(c, { ...mapping, enabled: e.target.checked }),
                  )
                }
              />
              <div className="profiles__app-card-top">
                <ExeIcon exe={mapping.exe} className="profiles__app-card-monogram" />
                <span className="profiles__app-card-name">{mapping.exe}</span>
              </div>
              <div className="profiles__app-card-meta">
                <span className="profiles__app-card-priority">P: {mapping.priority}</span>
                {mapping.titleIncludes && mapping.titleIncludes.length > 0 ? (
                  <span className="profiles__app-card-filter">
                    {mapping.titleIncludes.join(", ")}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}

        {activeProfile ? (
          <button
            type="button"
            className="profiles__add-card"
            onClick={() => handleCreateRule("example.exe", "", false)}
          >
            + Добавить правило
          </button>
        ) : null}
      </div>

      {selectedAppMappings.length === 0 && activeProfile ? (
        <p className="profiles__empty-hint">
          Правил пока нет. Нажмите «+ Добавить правило».
        </p>
      ) : null}

      {/* ── Rule editor modal ── */}
      {editingMapping ? (
        <AppMappingModal
          mapping={editingMapping}
          lastCapture={lastCapture}
          updateDraft={updateDraft}
          onClose={() => setEditingMappingId(null)}
          setConfirmModal={setConfirmModal}
        />
      ) : null}
    </div>
  );
}

/** Recursively collect action refs from menu items (used for export). */
function collectMenuActionRefs(
  items: { kind: string; actionRef?: string; items?: typeof items }[],
  refs: Set<string>,
): void {
  for (const item of items) {
    if (item.kind === "action" && item.actionRef) {
      refs.add(item.actionRef);
    } else if (item.kind === "submenu" && item.items) {
      collectMenuActionRefs(item.items, refs);
    }
  }
}
