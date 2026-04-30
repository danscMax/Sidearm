import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  reorderAppMappingPriority,
  upsertAppMapping,
} from "../lib/config-editing";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVizPanel } from "../hooks/useMouseVizPanel";
import { getExeIcon, readTextFile, writeTextFile } from "../lib/backend";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
} from "../lib/conflict-detection";
import { sortAppMappings } from "../lib/helpers";
import { ChipEditor } from "./ChipEditor";
import { ContextMenu } from "./ContextMenu";
import { MouseVisualization } from "./MouseVisualization";
import { RunningProcessPicker } from "./RunningProcessPicker";

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
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showProcessPicker, setShowProcessPicker] = useState(false);

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
        aria-label={`${mapping.exe}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className="rule-modal__close"
          onClick={onClose}
          aria-label={t("common.close")}
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
            <span className="rule-modal__profile-name">{t("ruleModal.profileLabel", { name: profileName })}</span>
          </div>
        </div>

        {/* Body */}
        <div className="rule-modal__body">
          <p className="rule-modal__description">
            {t("ruleModal.description", { name: profileName })}
          </p>

          {/* Exe input + Browse */}
          <div className="field">
            <span className="field__label">{t("ruleModal.exeLabel")}</span>
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
                    title: t("newRule.browseTitle"),
                    filters: [{ name: t("newRule.browseFilter"), extensions: ["exe", "lnk"] }],
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
                {t("common.browse")}
              </button>
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => setShowProcessPicker(true)}
                title={t("ruleModal.pickRunningTooltip")}
              >
                {t("ruleModal.pickRunning")}
              </button>
            </div>
            {mapping.processPath ? (
              <p
                className="field__description"
                style={{
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: "0.72rem",
                  opacity: 0.7,
                  wordBreak: "break-all",
                }}
                title={mapping.processPath}
              >
                {mapping.processPath}
              </p>
            ) : null}
          </div>

          {/* Title filters */}
          <div className="field">
            <span className="field__label">{t("ruleModal.titleLabel")}</span>
            <ChipEditor
              values={mapping.titleIncludes ?? []}
              onChange={(vals) =>
                updateDraft((c) =>
                  upsertAppMapping(c, {
                    ...mapping,
                    titleIncludes: vals.length > 0 ? vals : undefined,
                  }),
                )
              }
              placeholder={t("common.optional")}
              ariaLabel={t("ruleModal.titleLabel")}
            />
            <p className="field__description">
              {t("ruleModal.titleHelp")}
            </p>
          </div>

          {/* Toggle + Priority row */}
          <div className="rule-modal__inline-row">
            <label className="rule-modal__inline-field">
              <span className="field__label">{t("common.enabled")}</span>
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
                {t("ruleModal.priorityLabel")}
                <span
                  className="field__hint"
                  title={t("ruleModal.priorityTooltip")}
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
            <span className="field__label">{t("debug.profile")}</span>
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
              {t("ruleModal.moveProfileHelp")}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="rule-modal__footer">
          <span className="rule-modal__autosave">{t("ruleModal.autosave")}</span>
          <span className="rule-modal__spacer" />

          {confirmingDelete ? (
            <div className="rule-modal__delete-confirm">
              {t("ruleModal.deleteConfirm")}
              <button
                type="button"
                className="action-button action-button--small action-button--ghost profiles__delete-btn"
                onClick={() => {
                  updateDraft((c) => deleteAppMapping(c, mapping.id));
                  onClose();
                }}
              >
                {t("common.yes")}
              </button>
              <button
                type="button"
                className="action-button action-button--small action-button--ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                {t("common.no")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="action-button action-button--ghost profiles__delete-btn"
              onClick={() => setConfirmingDelete(true)}
            >
              {t("ruleModal.deleteRule")}
            </button>
          )}
        </div>
      </div>
      {showProcessPicker ? (
        <RunningProcessPicker
          onCancel={() => setShowProcessPicker(false)}
          onPick={(proc) => {
            updateDraft((c) =>
              upsertAppMapping(c, {
                ...mapping,
                exe: proc.exe.toLowerCase(),
                processPath: proc.path || undefined,
              }),
            );
            setShowProcessPicker(false);
          }}
        />
      ) : null}
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
  const { t } = useTranslation();
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
  const [bindingSearch, setBindingSearch] = useState("");

  // Drag-reorder state for the profile rules grid.
  const [draggingMappingId, setDraggingMappingId] = useState<string | null>(null);
  const [dragOverMappingId, setDragOverMappingId] = useState<string | null>(null);

  const conflictIds = useMemo(
    () => (activeConfig ? conflictingBindingIds(activeConfig) : new Set<string>()),
    [activeConfig],
  );

  const searchQuery = bindingSearch.trim();
  const matchedControlIds = useMemo(() => {
    if (!searchQuery) return null;
    const ids = new Set<ControlId>();
    for (const section of familySections) {
      for (const entry of section.entries) {
        if (bindingMatchesQuery(entry.binding, entry.action, searchQuery)) {
          ids.add(entry.control.id);
        }
      }
    }
    return ids;
  }, [familySections, searchQuery]);

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
  const surfaceEntries = useMemo(
    () => familySections.flatMap((section) => section.entries),
    [familySections],
  );

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
        title: t("confirm.duplicateRuleTitle"),
        message: t("confirm.duplicateRuleMessage", { exe: duplicate.exe }),
        confirmLabel: t("common.create"),
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
    <div
      className={`profiles-workspace profiles-workspace--layer-${selectedLayer}`}
    >
      {/* ── Layer indicator + search ── */}
      <div className="profiles-workspace__toolbar">
        <span className={`layer-badge layer-badge--${selectedLayer}`}>
          {selectedLayer === "hypershift"
            ? t("layer.hypershift")
            : t("layer.standard")}
        </span>
        <input
          type="search"
          className="profiles-workspace__search"
          placeholder={t("profile.searchPlaceholder")}
          value={bindingSearch}
          onChange={(e) => setBindingSearch(e.target.value)}
        />
        {searchQuery && matchedControlIds ? (
          <span className="profiles-workspace__search-meta">
            {t("profile.searchMeta", { count: matchedControlIds.size })}
          </span>
        ) : null}
      </div>

      {/* ── Mouse visualization ── */}
      <div className="profiles__mouse-viz">
        <MouseVisualization
          entries={surfaceEntries}
          selectedLayer={selectedLayer}
          multiSelectedControlIds={multiSelectedControlIds}
          matchedControlIds={matchedControlIds}
          conflictBindingIds={conflictIds}
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
            title={heatmapEnabled ? t("profile.heatmapDisable") : t("profile.heatmapEnable")}
          >
            {heatmapEnabled ? t("profile.heatmapOn") : t("profile.heatmapOff")}
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
                title: t("settings.exportDialogTitle"),
                defaultPath: `${activeProfile.name}.json`,
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (path) await writeTextFile(path, json);
            }}
          >
            {t("profile.exportProfile")}
          </button>
          <button
            type="button"
            className="action-button action-button--small"
            onClick={async () => {
              const path = await open({
                title: t("settings.importDialogTitle"),
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
            {t("profile.importProfile")}
          </button>
        </div>
      ) : null}

      {/* ── Section header ── */}
      <div className="profiles__section-header">
        <span>{t("profile.rulesHeader")}</span>
        <span className="profiles__section-count">{selectedAppMappings.length}</span>
      </div>

      {/* ── Card grid ── */}
      <div className="profiles__card-grid">
        {selectedAppMappings.map((mapping) => {
          const isActive = editingMapping?.id === mapping.id;
          const isDisabled = !mapping.enabled;
          const isDragging = draggingMappingId === mapping.id;
          const isDragOver = dragOverMappingId === mapping.id && draggingMappingId !== mapping.id;
          return (
            <button
              key={mapping.id}
              type="button"
              draggable
              className={`profiles__app-card${isActive ? " profiles__app-card--active" : ""}${isDisabled ? " profiles__app-card--disabled" : ""}${isDragging ? " profiles__app-card--dragging" : ""}${isDragOver ? " profiles__app-card--drag-over" : ""}`}
              onClick={() => setEditingMappingId(mapping.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setRuleCtxMenu({ x: e.clientX, y: e.clientY, mappingId: mapping.id });
              }}
              onDragStart={(e) => {
                setDraggingMappingId(mapping.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!draggingMappingId || draggingMappingId === mapping.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverMappingId !== mapping.id) setDragOverMappingId(mapping.id);
              }}
              onDragLeave={() => {
                if (dragOverMappingId === mapping.id) setDragOverMappingId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingMappingId && draggingMappingId !== mapping.id) {
                  updateDraft((c) =>
                    reorderAppMappingPriority(c, draggingMappingId, mapping.id),
                  );
                }
                setDraggingMappingId(null);
                setDragOverMappingId(null);
              }}
              onDragEnd={() => {
                setDraggingMappingId(null);
                setDragOverMappingId(null);
              }}
            >
              <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="profiles__app-card-monogram" />
              <span className="profiles__app-card-name">{mapping.exe.replace(/\.exe$/i, "")}</span>
              <input
                className="profiles__toggle"
                type="checkbox"
                checked={mapping.enabled}
                title={mapping.enabled ? t("common.disabled") : t("common.enabled")}
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
            title={t("profile.addRuleTooltip")}
          >
            {t("profile.addRule")}
          </button>
        ) : null}
      </div>

      {selectedAppMappings.length === 0 && activeProfile ? (
        <p className="profiles__empty-hint">
          {t("profile.emptyHint")}
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
              aria-label={t("common.close")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
            <div className="rule-modal__header">
              <span className="rule-modal__title">{t("newRule.title")}</span>
              <p className="rule-modal__subtitle">
                {t("newRule.subtitle")}
              </p>
            </div>
            <div className="rule-modal__body">
              <div className="field">
                <span className="field__label">{t("newRule.exe")}</span>
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
                        title: t("newRule.browseTitle"),
                        filters: [{ name: t("newRule.browseFilter"), extensions: ["exe", "lnk"] }],
                        multiple: false,
                      });
                      if (typeof selected === "string") {
                        const exeName = selected.split(/[/\\]/).pop() ?? selected;
                        setNewRuleExe(exeName.toLowerCase());
                        setNewRuleCapturedTitle("");
                      }
                    }}
                  >
                    {t("common.browse")}
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
                <span>{t("newRule.dropzone")}</span>
              </div>

              <div className="new-rule__divider">{t("newRule.divider")}</div>

              <div className="new-rule__capture">
                <button
                  type="button"
                  className="action-button action-button--accent new-rule__capture-btn"
                  onClick={() => { void handleCaptureForDialog(); }}
                  disabled={viewState === "loading" || viewState === "saving" || captureCountdown !== null}
                >
                  {captureCountdown !== null ? t("newRule.captureCountdown", { countdown: captureCountdown }) : t("newRule.captureButton")}
                </button>
                <div className="new-rule__delay-row">
                  <span className="new-rule__delay-label">{t("newRule.delayLabel")}</span>
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
                  {t("newRule.captureHelp")}
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
                    <span>{t("newRule.titleFilter")}</span>
                  </label>
                  {newRuleTitleEnabled ? (
                    <div className="new-rule__title-detail">
                      <span className="new-rule__title-value">{newRuleCapturedTitle}</span>
                      <p className="new-rule__title-hint">
                        {t("newRule.titleFilterHelp")}
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
                {t("common.create")}
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
                label: t("common.edit"),
                onClick: () => setEditingMappingId(targetMapping.id),
              },
              {
                label: t("common.duplicate"),
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
                label: t("common.delete"),
                danger: true,
                onClick: () => {
                  setConfirmModal({
                    title: t("confirm.deleteRuleTitle"),
                    message: t("confirm.deleteRuleMessage", { exe: targetMapping.exe }),
                    confirmLabel: t("common.delete"),
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
