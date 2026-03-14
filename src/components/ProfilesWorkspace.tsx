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
import { ContextMenu } from "./ContextMenu";
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
  profileName: string;
  lastCapture: WindowCaptureResult | null;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  onClose: () => void;
}

function AppMappingModal({
  mapping,
  profileName,
  lastCapture,
  updateDraft,
  onClose,
}: AppMappingModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
          <div>
            <span className="rule-modal__title">{mapping.exe}</span>
            <span className="rule-modal__profile-name">Профиль: {profileName}</span>
          </div>
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
                placeholder="chrome.exe"
                onChange={(e) =>
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, exe: e.target.value }))
                }
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
              <span className="field__label">
                Приоритет
                <span
                  className="field__hint"
                  title="Чем выше число, тем выше приоритет. При совпадении нескольких правил побеждает правило с наибольшим приоритетом."
                >
                  ?
                </span>
              </span>
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
          <span className="rule-modal__autosave">Изменения сохраняются автоматически</span>
          <span className="rule-modal__spacer" />

          {confirmingDelete ? (
            <div className="rule-modal__delete-confirm">
              Точно удалить?
              <button
                type="button"
                className="action-button action-button--small action-button--ghost profiles__delete-btn"
                onClick={() => {
                  updateDraft((c) => deleteAppMapping(c, mapping.id));
                  onClose();
                }}
              >
                Да
              </button>
              <button
                type="button"
                className="action-button action-button--small action-button--ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                Нет
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="action-button action-button--ghost profiles__delete-btn"
              onClick={() => setConfirmingDelete(true)}
            >
              Удалить правило
            </button>
          )}
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
  const [newRuleOpen, setNewRuleOpen] = useState(false);
  const [newRuleExe, setNewRuleExe] = useState("");
  const [newRuleCapturedTitle, setNewRuleCapturedTitle] = useState("");
  const [captureForNewRule, setCaptureForNewRule] = useState(false);
  const prevCaptureRef = useRef(lastCapture);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const [ruleCtxMenu, setRuleCtxMenu] = useState<{ x: number; y: number; mappingId: string } | null>(null);

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

  // Close profile menu on outside click
  useEffect(() => {
    if (!profileMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [profileMenuOpen]);

  // Fill new-rule dialog fields after capture completes
  useEffect(() => {
    if (
      captureForNewRule &&
      lastCapture &&
      lastCapture !== prevCaptureRef.current &&
      !lastCapture.ignored
    ) {
      setCaptureForNewRule(false);
      setNewRuleExe(lastCapture.exe);
      setNewRuleCapturedTitle(lastCapture.title);
    }
    prevCaptureRef.current = lastCapture;
  });

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

  async function handleCaptureForDialog() {
    setCaptureForNewRule(true);
    await handleCaptureWithCountdown();
  }

  function handleConfirmNewRule() {
    const exe = newRuleExe.trim().toLowerCase();
    if (!exe) return;
    const title = newRuleCapturedTitle;
    setNewRuleOpen(false);
    setNewRuleExe("");
    setNewRuleCapturedTitle("");
    handleCreateRule(exe, title, !!title);
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

      {/* ── Profile pill ── */}
      {activeProfile ? (
        <div className="profile-pill-row">
          <div className="profile-pill">
            <span className="profile-pill__avatar">{profileMonogram(activeProfile.name)}</span>
            <input
              type="text"
              className="profile-pill__name"
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
            <label className="profile-pill__toggle">
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
            {!activeProfile.enabled && (
              <span className="profile-pill__status">Отключён</span>
            )}
          </div>
          <div className="profile-pill__menu-wrap" ref={profileMenuRef}>
            <button
              type="button"
              className="profile-pill__menu-btn"
              onClick={() => setProfileMenuOpen((v) => !v)}
              aria-label="Действия с профилем"
            >
              ⋯
            </button>
            {profileMenuOpen && (
              <div className="profile-pill__dropdown">
                <button
                  type="button"
                  className="profile-pill__dropdown-item"
                  onClick={() => { handleDuplicateProfile(); setProfileMenuOpen(false); }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="5" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="var(--c-surface-alt)"/></svg>
                  Копировать
                </button>
                <button
                  type="button"
                  className="profile-pill__dropdown-item"
                  onClick={() => { handleExportProfile(); setProfileMenuOpen(false); }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Экспорт
                </button>
                {profiles.length > 1 && (
                  <button
                    type="button"
                    className="profile-pill__dropdown-item profile-pill__dropdown-item--danger"
                    onClick={() => {
                      setProfileMenuOpen(false);
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
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Удалить
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

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
              onContextMenu={(e) => {
                e.preventDefault();
                setRuleCtxMenu({ x: e.clientX, y: e.clientY, mappingId: mapping.id });
              }}
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
            onClick={() => { setNewRuleOpen(true); setNewRuleExe(""); }}
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

      {/* ── New rule dialog ── */}
      {newRuleOpen ? (
        <div className="modal-backdrop" onClick={() => setNewRuleOpen(false)}>
          <div
            className="rule-modal rule-modal--compact"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Escape") setNewRuleOpen(false); }}
          >
            <div className="rule-modal__header">
              <span className="rule-modal__title">Новое правило</span>
              <button
                type="button"
                className="rule-modal__close"
                onClick={() => setNewRuleOpen(false)}
                aria-label="Закрыть"
              >
                &times;
              </button>
            </div>
            <div
              className={`rule-modal__body new-rule__dropzone${newRuleExe ? "" : " new-rule__dropzone--empty"}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).classList.add("dragover");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  (e.currentTarget as HTMLElement).classList.remove("dragover");
                }
              }}
              onDrop={(e) => {
                (e.currentTarget as HTMLElement).classList.remove("dragover");
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) {
                  const name = file.name.replace(/\.lnk$/i, ".exe").toLowerCase();
                  if (name.endsWith(".exe")) {
                    setNewRuleExe(name);
                    setNewRuleCapturedTitle("");
                  }
                }
              }}
            >
              <div className="field">
                <span className="field__label">Исполняемый файл</span>
                <div className="field__row">
                  <input
                    type="text"
                    autoFocus
                    value={newRuleExe}
                    placeholder="chrome.exe, telegram.exe..."
                    onChange={(e) => { setNewRuleExe(e.target.value); setNewRuleCapturedTitle(""); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newRuleExe.trim()) handleConfirmNewRule();
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
                        setNewRuleExe(exeName.toLowerCase());
                        setNewRuleCapturedTitle("");
                      }
                    }}
                  >
                    Обзор...
                  </button>
                </div>
                {!newRuleExe && (
                  <span className="new-rule__drop-hint">или перетащите .exe / ярлык сюда</span>
                )}
              </div>

              <div className="new-rule__divider">или</div>

              <div className="new-rule__capture">
                <button
                  type="button"
                  className="new-rule__capture-btn"
                  onClick={() => { void handleCaptureForDialog(); }}
                  disabled={viewState === "loading" || viewState === "saving" || captureCountdown !== null}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  {captureCountdown !== null ? `${captureCountdown}...` : "Захватить активное окно"}
                </button>
                <select
                  className="new-rule__delay"
                  value={captureDelayMs}
                  onChange={(e) => setCaptureDelayMs(Number(e.target.value))}
                  title="Задержка: переключитесь на нужное окно за это время"
                >
                  <option value={500}>0.5с</option>
                  <option value={1000}>1с</option>
                  <option value={1500}>1.5с</option>
                  <option value={2000}>2с</option>
                  <option value={3000}>3с</option>
                  <option value={5000}>5с</option>
                </select>
              </div>

              {newRuleCapturedTitle ? (
                <p className="new-rule__captured-title">
                  Заголовок: {newRuleCapturedTitle}
                </p>
              ) : null}
            </div>
            <div className="rule-modal__footer">
              <button
                type="button"
                className="action-button action-button--accent"
                disabled={!newRuleExe.trim()}
                onClick={handleConfirmNewRule}
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Rule editor modal ── */}
      {editingMapping ? (
        <AppMappingModal
          mapping={editingMapping}
          profileName={activeProfile?.name ?? ""}
          lastCapture={lastCapture}
          updateDraft={updateDraft}
          onClose={() => setEditingMappingId(null)}
        />
      ) : null}

      {/* ── Rule context menu ── */}
      {ruleCtxMenu ? (() => {
        const targetMapping = selectedAppMappings.find((m) => m.id === ruleCtxMenu.mappingId);
        if (!targetMapping) return null;
        return (
          <ContextMenu
            x={ruleCtxMenu.x}
            y={ruleCtxMenu.y}
            onClose={() => setRuleCtxMenu(null)}
            items={[
              {
                label: "Редактировать",
                onClick: () => setEditingMappingId(targetMapping.id),
              },
              {
                label: "Дублировать",
                onClick: () => {
                  if (!activeProfile) return;
                  let newId: string | null = null;
                  updateDraft((config) => {
                    const result = createAppMappingFromCapture(
                      config,
                      activeProfile.id,
                      targetMapping.priority,
                      targetMapping.exe,
                      (targetMapping.titleIncludes ?? [])[0] ?? "",
                      !!(targetMapping.titleIncludes && targetMapping.titleIncludes.length > 0),
                    );
                    newId = result.newMappingId;
                    return result.config;
                  });
                  if (newId) {
                    startTransition(() => setEditingMappingId(newId));
                  }
                },
              },
              null,
              {
                label: "Удалить",
                danger: true,
                onClick: () => {
                  setConfirmModal({
                    title: "Удалить правило?",
                    message: `Правило для «${targetMapping.exe}» будет удалено.`,
                    confirmLabel: "Удалить",
                    onConfirm: () => {
                      updateDraft((c) => deleteAppMapping(c, targetMapping.id));
                      setConfirmModal(null);
                    },
                  });
                },
              },
            ]}
          />
        );
      })() : null}
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
