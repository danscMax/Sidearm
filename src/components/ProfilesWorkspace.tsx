import { startTransition, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppConfig, ControlId, Layer, Profile } from "../lib/config";
import type { ProfileExportData } from "../lib/config-editing";
import type { FamilySection, ViewState } from "../lib/constants";
import type { WindowCaptureResult } from "../lib/runtime";
import {
  copyBindingFromLayer,
  createAppMappingFromCapture,
  deleteAppMapping,
  duplicateBinding,
  extractProfileExport,
  findDuplicateAppMapping,
  importProfile,
  isValidProfileExport,
  removeBinding,
  reorderAppMappingPriority,
  upsertAppMapping,
  upsertBinding,
} from "../lib/config-editing";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVisualPanel } from "../hooks/useMouseVisualPanel";
import { exportProfileFile, importProfileFile, pickExecutablePath } from "../lib/backend";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
} from "../lib/conflict-detection";
import { sortAppMappings, toggleInSet } from "../lib/helpers";
import { ContextMenu } from "./ContextMenu";
import { MouseVisualization } from "./MouseVisualization";
import { CloseButton, ModalShell } from "./shared";
import { ExeIcon } from "./ExeIcon";
import { AppMappingModal } from "./AppMappingModal";

export interface ProfilesWorkspaceProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  addRuleSignal: boolean;
  onAddRuleHandled: () => void;
  lastCapture: WindowCaptureResult | null;
  captureDelayMs: number;
  viewState: ViewState;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setCaptureDelayMs: (ms: number) => void;
  setConfirmModal: (modal: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null) => void;
  handleCaptureActiveWindow: () => Promise<void>;
  setProfileSyncSuppressed: (suppressed: boolean) => void;
  familySections: FamilySection[];
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectLayer: (layer: Layer) => void;
  setSelectedProfileId: (id: string | null) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
  executionCounts?: Map<string, number>;
  heatmapEnabledRef?: RefObject<boolean>;
  showToast: (message: string, kind?: "info" | "success" | "warning") => void;
}

/* ────────────────────────────────────────────────────────────
   Profiles Workspace
   ──────────────────────────────────────────────────────────── */

export function ProfilesWorkspace({
  activeConfig,
  activeProfile,
  effectiveProfileId,
  addRuleSignal,
  onAddRuleHandled,
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
  setSelectedProfileId,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
  executionCounts,
  heatmapEnabledRef,
  showToast,
}: ProfilesWorkspaceProps) {
  const { t } = useTranslation();
  const { heatmapEnabled, setHeatmapEnabled, handleDropBinding } = useMouseVisualPanel({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
  });

  // Mirror heatmap state into the ref useRuntime reads, so execution-count
  // bookkeeping is skipped while the heatmap is off.
  useEffect(() => {
    if (heatmapEnabledRef) heatmapEnabledRef.current = heatmapEnabled;
  }, [heatmapEnabled, heatmapEnabledRef]);

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
  const [bindingCtxMenu, setBindingCtxMenu] = useState<
    { x: number; y: number; controlId: ControlId; bindingId: string | null } | null
  >(null);
  const [bindingSearch, setBindingSearch] = useState("");
  const [searchAllProfiles, setSearchAllProfiles] = useState(false);

  // Open the new-rule dialog when the command palette requests it, then ack
  // so a later remount (mode switch) doesn't reopen it.
  useEffect(() => {
    if (addRuleSignal) {
      setNewRuleOpen(true);
      setNewRuleExe("");
      onAddRuleHandled();
    }
  }, [addRuleSignal]);

  // Drag-reorder state for the profile rules grid.
  const [draggingMappingId, setDraggingMappingId] = useState<string | null>(null);
  const [dragOverMappingId, setDragOverMappingId] = useState<string | null>(null);

  const conflictIds = useMemo(
    () => (activeConfig ? conflictingBindingIds(activeConfig) : new Set<string>()),
    [activeConfig],
  );

  // Conflict groups scoped to what's currently on screen (this profile + layer),
  // so the banner names exactly the buttons the user can see.
  const layerConflicts = useMemo(
    () =>
      findShortcutConflicts(activeConfig).filter(
        (g) => g.profileId === effectiveProfileId && g.layer === selectedLayer,
      ),
    [activeConfig, effectiveProfileId, selectedLayer],
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

  // Cross-profile search: scan every binding in the config (bindingMatchesQuery
  // is profile-agnostic) so the user can find a shortcut wherever it's bound.
  const crossProfileResults = useMemo(() => {
    if (!searchQuery || !searchAllProfiles) return [];
    const actionsById = new Map(activeConfig.actions.map((a) => [a.id, a]));
    const profilesById = new Map(activeConfig.profiles.map((p) => [p.id, p]));
    const controlsById = new Map(activeConfig.physicalControls.map((c) => [c.id, c]));
    return activeConfig.bindings
      .filter((b) => bindingMatchesQuery(b, actionsById.get(b.actionId) ?? null, searchQuery))
      .map((b) => ({
        binding: b,
        profileName: profilesById.get(b.profileId)?.name ?? b.profileId,
        controlName: controlsById.get(b.controlId)?.defaultName ?? b.controlId,
      }));
  }, [activeConfig, searchQuery, searchAllProfiles]);

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

  // Fill new-rule dialog fields after capture completes.
  // Depends only on lastCapture; captureForNewRule is the consumer flag we
  // read inside.  Previously this effect had NO dependency array and ran on
  // every render — cheap on its own, but it amplified the cost of the
  // upstream debug-log poll-storm.
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
  }, [lastCapture, captureForNewRule]);

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
          {/* Both labels are rendered (the inactive one hidden) so the badge
              always reserves the width of the widest layer name — toggling the
              layer never shifts the search field beside it. */}
          <span className="layer-badge__opt" aria-hidden={selectedLayer === "hypershift"}>
            {t("layer.standard")}
          </span>
          <span className="layer-badge__opt" aria-hidden={selectedLayer !== "hypershift"}>
            {t("layer.hypershift")}
          </span>
        </span>
        <input
          type="search"
          className="profiles-workspace__search"
          placeholder={t("profile.searchPlaceholder")}
          value={bindingSearch}
          onChange={(e) => setBindingSearch(e.target.value)}
        />
        {searchQuery && !searchAllProfiles && matchedControlIds ? (
          <span className="profiles-workspace__search-meta">
            {t("profile.searchMeta", { count: matchedControlIds.size })}
          </span>
        ) : null}
        <button
          type="button"
          className={`action-button action-button--small${searchAllProfiles ? " action-button--active" : ""}`}
          onClick={() => setSearchAllProfiles((v) => !v)}
        >
          {t("profile.searchAllProfiles")}
        </button>
      </div>

      {searchAllProfiles && searchQuery ? (
        <div className="profiles__search-results">
          {crossProfileResults.length === 0 ? (
            <p className="props-empty__text">{t("profile.searchNoResults")}</p>
          ) : (
            <ul className="profiles__search-results-list">
              {crossProfileResults.map((r) => (
                <li key={r.binding.id}>
                  <button
                    type="button"
                    className="profiles__search-result"
                    onClick={() => {
                      setSelectedProfileId(r.binding.profileId);
                      onSelectLayer(r.binding.layer);
                      startTransition(() => setSelectedControlId(r.binding.controlId));
                      setSearchAllProfiles(false);
                    }}
                  >
                    <span className="profiles__search-result-profile">{r.profileName}</span>
                    <span className="profiles__search-result-meta">
                      {(r.binding.layer === "hypershift" ? t("layer.hypershift") : t("layer.standard"))}
                      {" · "}{r.controlName}{" · "}{r.binding.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {layerConflicts.length > 0 ? (
        <div className="notice notice--warning profiles__conflict-banner">
          <strong>{t("conflict.banner", { count: layerConflicts.length })}</strong>
          <ul>
            {layerConflicts.map((g) => (
              <li key={`${g.layer}:${g.signature}`}>
                {t("conflict.group", {
                  signature: g.signature,
                  controls: g.bindings.map((b) => b.label).join(", "),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
            setMultiSelectedControlIds((prev) => toggleInSet(prev, id));
          }}
          onOpenActionPicker={handleOpenActionPicker}
          onContextMenu={(id, binding, _action, x, y) =>
            setBindingCtxMenu({ x, y, controlId: id, bindingId: binding?.id ?? null })
          }
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
              try {
                const data = extractProfileExport(activeConfig, activeProfile.id);
                const json = JSON.stringify(data, null, 2);
                const path = await save({
                  title: t("settings.exportDialogTitle"),
                  defaultPath: `${activeProfile.name}.json`,
                  filters: [{ name: "JSON", extensions: ["json"] }],
                });
                if (path) await exportProfileFile(path, json);
              } catch {
                showToast(t("settings.exportProfileError"), "warning");
              }
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
                const json = await importProfileFile(path);
                const data = JSON.parse(json) as ProfileExportData;
                if (!isValidProfileExport(data)) {
                  showToast(t("settings.invalidProfileError"), "warning");
                  return;
                }
                updateDraft((c) => importProfile(c, data));
              } catch {
                showToast(t("settings.readProfileError"), "warning");
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
        <div className="props-empty">
          <p className="props-empty__icon" aria-hidden="true">⊹</p>
          <p className="props-empty__text">{t("profile.emptyHint")}</p>
        </div>
      ) : null}

      {/* ── New rule dialog ── */}
      {newRuleOpen ? (
        <ModalShell
          onClose={() => setNewRuleOpen(false)}
          className="rule-modal rule-modal--compact"
        >
            <CloseButton onClick={() => setNewRuleOpen(false)} ariaLabel={t("common.close")} />
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
                      const pick = await pickExecutablePath({
                        title: t("newRule.browseTitle"),
                        filterName: t("newRule.browseFilter"),
                        extensions: ["exe", "lnk"],
                      });
                      if (pick) {
                        setNewRuleExe(pick.name);
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
        </ModalShell>
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
                    danger: true,
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
      {bindingCtxMenu ? (() => {
        const binding = bindingCtxMenu.bindingId
          ? activeConfig.bindings.find((b) => b.id === bindingCtxMenu.bindingId) ?? null
          : null;
        const cid = bindingCtxMenu.controlId;
        const otherLayer: Layer = selectedLayer === "hypershift" ? "standard" : "hypershift";
        const otherLayerLabel = otherLayer === "hypershift" ? t("layer.hypershift") : t("layer.standard");
        return (
          <ContextMenu
            x={bindingCtxMenu.x}
            y={bindingCtxMenu.y}
            onClose={() => setBindingCtxMenu(null)}
            items={[
              {
                label: t("common.edit"),
                onClick: () => handleOpenActionPicker(cid, binding),
              },
              {
                label: t("common.duplicate"),
                disabled: !binding,
                onClick: () => {
                  if (binding) updateDraft((c) => duplicateBinding(c, binding.id, cid));
                },
              },
              {
                label: t("assignments.copyToLayer", { layer: otherLayerLabel }),
                disabled: !binding || !effectiveProfileId,
                onClick: () => {
                  if (binding && effectiveProfileId)
                    updateDraft((c) =>
                      copyBindingFromLayer(c, effectiveProfileId, cid, selectedLayer, otherLayer),
                    );
                },
              },
              {
                label: binding?.enabled ? t("assignments.disable") : t("assignments.enable"),
                disabled: !binding,
                onClick: () => {
                  if (binding)
                    updateDraft((c) => upsertBinding(c, { ...binding, enabled: !binding.enabled }));
                },
              },
              null,
              {
                label: t("assignments.clear"),
                danger: true,
                disabled: !binding,
                onClick: () => {
                  if (binding) updateDraft((c) => removeBinding(c, binding.id));
                },
              },
            ]}
          />
        );
      })() : null}
    </div>
  );
}
