import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig, AppMapping, ControlId, Layer, Profile } from "../lib/config";
import type { ProfileExportData } from "../lib/config-editing";
import type { FamilySection, ViewState } from "../lib/constants";
import type { WindowCaptureResult } from "../lib/runtime";
import {
  createAppMappingFromCapture,
  deleteAppMapping,
  extractProfileExport,
  findDuplicateAppMapping,
  mergeImportedProfile,
  upsertAppMapping,
} from "../lib/config-editing";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVizPanel } from "../hooks/useMouseVizPanel";
import { getExeIcon, readTextFile, writeTextFile } from "../lib/backend";
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
  effectiveProfileId: string | null;
  lastCapture: WindowCaptureResult | null;
  captureDelayMs: number;
  viewState: ViewState;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setCaptureDelayMs: (ms: number) => void;
  setConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null) => void;
  handleCaptureActiveWindow: () => Promise<void>;
  setProfileSyncSuppressed: (suppressed: boolean) => void;
  familySections: FamilySection[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectLayer: (layer: Layer) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
  executionCounts?: Map<string, number>;
}

/** First 2 uppercase letters of exe name (sans extension) for monogram icon. */
function exeMonogram(exe: string): string {
  const base = exe.replace(/\.exe$/i, "");
  return base.slice(0, 2).toUpperCase();
}

/** Renders an exe icon (fetched from backend) with monogram fallback. */
function ExeIcon({ exe, processPath, className }: { exe: string; processPath?: string; className: string }) {
  const cacheKey = exe;
  const [iconSrc, setIconSrc] = useState<string | null>(() => {
    const cached = exeIconCache.get(cacheKey);
    return cached ? `data:image/png;base64,${cached}` : null;
  });

  useEffect(() => {
    if (exeIconCache.has(cacheKey)) {
      const v = exeIconCache.get(cacheKey)!;
      setIconSrc(v ? `data:image/png;base64,${v}` : null);
      return;
    }

    let cancelled = false;
    let pending = exeIconPending.get(cacheKey);
    if (!pending) {
      pending = getExeIcon(exe, processPath);
      exeIconPending.set(cacheKey, pending);
    }
    pending.then((b64) => {
      exeIconCache.set(cacheKey, b64 ?? "");
      exeIconPending.delete(cacheKey);
      if (!cancelled && b64) {
        setIconSrc(`data:image/png;base64,${b64}`);
      }
    }).catch(() => {
      exeIconCache.set(cacheKey, "");
      exeIconPending.delete(cacheKey);
    });
    return () => { cancelled = true; };
  }, [exe, processPath]);

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
  activeConfig: AppConfig;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  onClose: () => void;
}

function AppMappingModal({
  mapping,
  profileName,
  activeConfig,
  updateDraft,
  onClose,
}: AppMappingModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
        <button
          type="button"
          className="rule-modal__close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>

        {/* Header */}
        <div className="rule-modal__header">
          <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="profiles__app-card-monogram" />
          <div>
            <span className="rule-modal__title">{mapping.exe}</span>
            <span className="rule-modal__profile-name">Профиль: {profileName}</span>
          </div>
        </div>

        {/* Body */}
        <div className="rule-modal__body">
          <p className="rule-modal__description">
            Когда это приложение окажется в фокусе, профиль «{profileName}» активируется автоматически.
          </p>

          {/* Exe input + Browse */}
          <div className="field">
            <span className="field__label">Исполняемый файл</span>
            <div className="field__row">
              <input
                type="text"
                value={mapping.exe}
                placeholder="chrome.exe"
                onChange={(e) =>
                  updateDraft((c) => upsertAppMapping(c, { ...mapping, exe: e.target.value, processPath: undefined }))
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
                      upsertAppMapping(c, { ...mapping, exe: exeName.toLowerCase(), processPath: selected }),
                    );
                  }
                }}
              >
                Обзор...
              </button>
            </div>
          </div>

          {/* Title filters */}
          <div className="field">
            <span className="field__label">Фильтр по заголовку окна</span>
            <input
              type="text"
              defaultValue={(mapping.titleIncludes ?? []).join(", ")}
              key={mapping.id}
              placeholder="необязательно"
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
            <p className="field__description">
              Оставьте пустым — правило сработает для любого окна этого приложения.
              Укажите текст — только если заголовок окна его содержит.
            </p>
          </div>

          {/* Toggle + Priority row */}
          <div className="rule-modal__inline-row">
            <label className="rule-modal__inline-field">
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

            <label className="rule-modal__inline-field">
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

          {/* Move to another profile */}
          <div className="field">
            <span className="field__label">Профиль</span>
            <select
              value={mapping.profileId}
              onChange={(e) => {
                const newProfileId = e.target.value;
                if (newProfileId !== mapping.profileId) {
                  updateDraft((c) =>
                    upsertAppMapping(c, { ...mapping, profileId: newProfileId }),
                  );
                }
              }}
            >
              {activeConfig.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="field__description">
              Переместите правило в другой профиль.
            </p>
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
  effectiveProfileId,
  lastCapture,
  captureDelayMs,
  viewState,
  updateDraft,
  setCaptureDelayMs,
  setConfirmModal,
  handleCaptureActiveWindow,
  setProfileSyncSuppressed,
  familySections,
  selectedLayer,
  multiSelectedControlIds,
  onSelectLayer,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
  executionCounts,
}: ProfilesWorkspaceProps) {
  const { heatmapEnabled, setHeatmapEnabled, handleDropBinding } = useMouseVizPanel({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
  });

  const handleOpenActionPicker = useActionPicker({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  });

  const [editingMappingId, setEditingMappingId] = useState<string | null>(null);
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [newRuleOpen, setNewRuleOpen] = useState(false);
  const [newRuleExe, setNewRuleExe] = useState("");
  const [newRuleCapturedTitle, setNewRuleCapturedTitle] = useState("");
  const [newRuleCapturedProcessPath, setNewRuleCapturedProcessPath] = useState("");
  const [newRuleTitleEnabled, setNewRuleTitleEnabled] = useState(false);
  const [captureForNewRule, setCaptureForNewRule] = useState(false);
  const prevCaptureRef = useRef(lastCapture);
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
      setNewRuleCapturedProcessPath(lastCapture.processPath);
    }
    prevCaptureRef.current = lastCapture;
  });

  async function handleCaptureWithCountdown() {
    const totalMs = captureDelayMs;
    const startTime = Date.now();
    setCaptureCountdown(Math.ceil(totalMs / 1000));

    // Suppress profile auto-switching for the entire capture duration
    // (countdown + delay + capture). Without this, Alt+Tabbing to the
    // target window triggers foreground watcher → profile sync → UI
    // switches away from the user's chosen profile.
    setProfileSyncSuppressed(true);

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
      setProfileSyncSuppressed(false);
    }
  }

  async function handleCaptureForDialog() {
    setCaptureForNewRule(true);
    await handleCaptureWithCountdown();
  }

  function handleConfirmNewRule() {
    const exe = newRuleExe.trim().toLowerCase();
    if (!exe) return;
    const title = newRuleTitleEnabled ? newRuleCapturedTitle : "";
    const processPath = newRuleCapturedProcessPath || undefined;
    setNewRuleOpen(false);
    setNewRuleExe("");
    setNewRuleCapturedTitle("");
    setNewRuleCapturedProcessPath("");
    setNewRuleTitleEnabled(false);
    handleCreateRule(exe, title, newRuleTitleEnabled && !!title, processPath);
  }

  function handleCreateRule(exe: string, title: string, withTitleFilter: boolean, processPath?: string) {
    if (!activeProfile) return;
    const duplicate = findDuplicateAppMapping(activeConfig, activeProfile.id, exe);
    if (duplicate) {
      setConfirmModal({
        title: "Правило уже существует",
        message: `Для «${duplicate.exe}» уже есть правило в этом профиле. Создать ещё одно?`,
        confirmLabel: "Создать",
        onConfirm: () => {
          doCreateRule(exe, title, withTitleFilter, processPath);
          setConfirmModal(null);
        },
      });
      return;
    }
    doCreateRule(exe, title, withTitleFilter, processPath);
  }

  function doCreateRule(exe: string, title: string, withTitleFilter: boolean, processPath?: string) {
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
        processPath,
      );
      newId = result.newMappingId;
      return result.config;
    });
    if (newId) {
      startTransition(() => setEditingMappingId(newId));
    }
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
          executionCounts={executionCounts}
          heatmapEnabled={heatmapEnabled}
          onDropBinding={handleDropBinding}
        />
        <div className="heatmap-toggle">
          <button
            type="button"
            className={`action-button action-button--small${heatmapEnabled ? " action-button--active" : ""}`}
            onClick={() => setHeatmapEnabled((prev) => !prev)}
            title={heatmapEnabled ? "Выключить тепловую карту" : "Включить тепловую карту"}
          >
            {heatmapEnabled ? "Тепловая карта: вкл" : "Тепловая карта: выкл"}
          </button>
        </div>
      </div>

      {/* ── Profile actions ── */}
      {activeProfile ? (
        <div className="profiles__profile-actions">
          <button
            type="button"
            className="action-button action-button--small"
            onClick={async () => {
              if (!activeConfig || !activeProfile) return;
              const data = extractProfileExport(activeConfig, activeProfile.id);
              const json = JSON.stringify(data, null, 2);
              const path = await save({
                title: "Экспорт профиля",
                defaultPath: `${activeProfile.name}.json`,
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (path) await writeTextFile(path, json);
            }}
          >
            Экспорт профиля
          </button>
          <button
            type="button"
            className="action-button action-button--small"
            onClick={async () => {
              const path = await open({
                title: "Импорт профиля",
                filters: [{ name: "JSON", extensions: ["json"] }],
                multiple: false,
              });
              if (typeof path !== "string" || !activeConfig) return;
              try {
                const json = await readTextFile(path);
                const data = JSON.parse(json) as ProfileExportData;
                if (!data.profile || !data.version) {
                  console.error("Invalid profile export file");
                  return;
                }
                updateDraft((c) => mergeImportedProfile(c, data));
              } catch (e) {
                console.error("Failed to import profile:", e);
              }
            }}
          >
            Импорт профиля
          </button>
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
              <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="profiles__app-card-monogram" />
              <span className="profiles__app-card-name">{mapping.exe.replace(/\.exe$/i, "")}</span>
              <input
                className="profiles__toggle"
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
            </button>
          );
        })}

        {activeProfile ? (
          <button
            type="button"
            className="profiles__add-card"
            onClick={() => { setNewRuleOpen(true); setNewRuleExe(""); }}
            title="Привязать приложение к этому профилю. При фокусе на приложение профиль переключится автоматически."
          >
            + Добавить правило
          </button>
        ) : null}
      </div>

      {selectedAppMappings.length === 0 && activeProfile ? (
        <p className="profiles__empty-hint">
          Правил пока нет. Нажмите «+ Добавить правило», чтобы привязать приложение к этому профилю.
          При фокусе на привязанное приложение профиль переключится автоматически.
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
            <button
              type="button"
              className="rule-modal__close"
              onClick={() => setNewRuleOpen(false)}
              aria-label="Закрыть"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
            <div className="rule-modal__header">
              <span className="rule-modal__title">Новое правило</span>
              <p className="rule-modal__subtitle">
                Укажите приложение — профиль переключится автоматически при фокусе на него.
              </p>
            </div>
            <div className="rule-modal__body">
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
              </div>

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
                    if (name.endsWith(".exe")) {
                      setNewRuleExe(name);
                      setNewRuleCapturedTitle("");
                    }
                  }
                }}
              >
                <svg className="new-rule__dropzone-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span>Перетащите .exe или ярлык сюда</span>
              </div>

              <div className="new-rule__divider">или</div>

              <div className="new-rule__capture">
                <button
                  type="button"
                  className="action-button action-button--accent new-rule__capture-btn"
                  onClick={() => { void handleCaptureForDialog(); }}
                  disabled={viewState === "loading" || viewState === "saving" || captureCountdown !== null}
                >
                  {captureCountdown !== null ? `Переключитесь на окно... ${captureCountdown}` : "Захватить активное окно"}
                </button>
                <div className="new-rule__delay-row">
                  <span className="new-rule__delay-label">Задержка:</span>
                  <div className="new-rule__delay-pills">
                    {[
                      { value: 1000, label: "1с" },
                      { value: 2000, label: "2с" },
                      { value: 3000, label: "3с" },
                      { value: 5000, label: "5с" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`new-rule__delay-pill${captureDelayMs === opt.value ? " new-rule__delay-pill--active" : ""}`}
                        onClick={() => setCaptureDelayMs(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="new-rule__capture-hint">
                  Нажмите кнопку и переключитесь на нужное окно за выбранное время.
                  После задержки программа определит приложение и заполнит поля.
                </p>
              </div>

              {newRuleExe && newRuleCapturedTitle ? (
                <div className="new-rule__capture-result">
                  <div className="new-rule__capture-result-row">
                    <ExeIcon exe={newRuleExe} processPath={newRuleCapturedProcessPath || undefined} className="profiles__app-card-monogram" />
                    <span className="new-rule__capture-exe">{newRuleExe}</span>
                  </div>
                  <label className="new-rule__title-toggle">
                    <input
                      className="profiles__toggle"
                      type="checkbox"
                      checked={newRuleTitleEnabled}
                      onChange={(e) => setNewRuleTitleEnabled(e.target.checked)}
                    />
                    <span>Фильтр по заголовку</span>
                  </label>
                  {newRuleTitleEnabled ? (
                    <div className="new-rule__title-detail">
                      <span className="new-rule__title-value">{newRuleCapturedTitle}</span>
                      <p className="new-rule__title-hint">
                        Правило сработает только если заголовок окна содержит этот текст.
                        Без фильтра — сработает для любого окна этого приложения.
                      </p>
                    </div>
                  ) : null}
                </div>
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
          activeConfig={activeConfig}
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
