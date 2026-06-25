import { startTransition, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmModalRequest } from "./ConfirmModal";
import type { AppConfig, AppMapping, ControlId, Layer, Profile } from "../lib/config";
import type { FamilySection, ViewState } from "../lib/constants";
import type { WindowCaptureResult } from "../lib/runtime";
import {
  copyBindingFromLayer,
  createAppMapping,
  createAppMappingFromCapture,
  deleteAppMapping,
  duplicateBinding,
  findDuplicateAppMapping,
  importProfile,
  removeBinding,
  reorderAppMappingPriority,
  upsertAppMapping,
  upsertBinding,
} from "../lib/config-editing";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVisualPanel } from "../hooks/useMouseVisualPanel";
import { exportProfileToFile, importProfileFromFile } from "../lib/profile-transfer";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
} from "../lib/conflict-detection";
import { sortAppMappings, toggleInSet } from "../lib/helpers";
import { displayNameForControl } from "../lib/labels";
import { ContextMenu } from "./ContextMenu";
import { MouseVisualization } from "./MouseVisualization";
import { Notice } from "./shared";
import { ExeIcon } from "./ExeIcon";
import { AppMappingModal } from "./AppMappingModal";
import { CaptureControls } from "./CaptureControls";

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
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
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
  // Working draft for the unified "create rule" card (null = closed). Held
  // locally and only committed to the config on "Create"; the same
  // AppMappingModal renders it as a draft and existing rules as autosaved.
  const [creatingDraft, setCreatingDraft] = useState<AppMapping | null>(null);
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
      openCreateRule();
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
      .map((b) => {
        const control = controlsById.get(b.controlId);
        return {
          binding: b,
          profileName: profilesById.get(b.profileId)?.name ?? b.profileId,
          controlName: control ? displayNameForControl(control, "raw") : b.controlId,
        };
      });
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
      const cap = lastCapture;
      setCaptureForNewRule(false);
      setCreatingDraft((draft) =>
        draft
          ? {
              ...draft,
              exe: cap.exe,
              processPath: cap.processPath || undefined,
              // Pre-fill the captured window title as an editable chip; the user
              // can tweak or remove it (empty = match any window of this app).
              titleIncludes: cap.title ? [cap.title] : draft.titleIncludes,
            }
          : draft,
      );
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

  function openCreateRule() {
    if (!activeProfile) return;
    setCreatingDraft({
      id: "",
      exe: "",
      processPath: undefined,
      titleIncludes: undefined,
      profileId: activeProfile.id,
      enabled: true,
      priority: activeProfile.priority,
    });
  }

  function handleCreateFromDraft() {
    const draft = creatingDraft;
    if (!draft) return;
    const exe = draft.exe.trim().toLowerCase();
    if (!exe) return;
    const commit = () => {
      updateDraft((config) =>
        createAppMapping(config, {
          exe,
          processPath: draft.processPath,
          profileId: draft.profileId,
          enabled: draft.enabled,
          priority: draft.priority,
          titleIncludes: draft.titleIncludes,
        }).config,
      );
      setCreatingDraft(null);
    };
    // Duplicate check against the CHOSEN profile (the user may have changed it
    // in the card's profile selector before pressing Create).
    const duplicate = findDuplicateAppMapping(activeConfig, draft.profileId, exe);
    if (duplicate) {
      setConfirmModal({
        title: t("confirm.duplicateRuleTitle"),
        message: t("confirm.duplicateRuleMessage", { exe: duplicate.exe }),
        confirmLabel: t("common.create"),
        onConfirm: () => {
          commit();
          setConfirmModal(null);
        },
      });
      return;
    }
    commit();
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
        <Notice variant="warning" className="profiles__conflict-banner">
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
        </Notice>
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
                await exportProfileToFile(
                  activeConfig,
                  activeProfile.id,
                  activeProfile.name,
                  t("settings.exportDialogTitle"),
                );
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
              if (!activeConfig) return;
              try {
                const result = await importProfileFromFile(t("settings.importDialogTitle"));
                if (result.status === "cancelled") return;
                if (result.status === "invalid") {
                  showToast(t("settings.invalidProfileError"), "warning");
                  return;
                }
                updateDraft((c) => importProfile(c, result.data));
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
            onClick={openCreateRule}
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

      {/* ── Create-rule card (unified with the editor) ── */}
      {creatingDraft ? (
        <AppMappingModal
          mode="create"
          value={creatingDraft}
          onChange={setCreatingDraft}
          profiles={activeConfig.profiles}
          onClose={() => setCreatingDraft(null)}
          onCreate={handleCreateFromDraft}
          captureSlot={
            <CaptureControls
              countdown={captureCountdown}
              delayMs={captureDelayMs}
              onSelectDelay={setCaptureDelayMs}
              onCapture={() => { void handleCaptureForDialog(); }}
              onDropExe={(name) =>
                setCreatingDraft((d) =>
                  d ? { ...d, exe: name, processPath: undefined, titleIncludes: undefined } : d,
                )
              }
              disabled={viewState === "loading" || viewState === "saving" || captureCountdown !== null}
            />
          }
        />
      ) : null}

      {/* ── Rule editor card ── */}
      {editingMapping ? (
        <AppMappingModal
          mode="edit"
          value={editingMapping}
          onChange={(next) => updateDraft((c) => upsertAppMapping(c, next))}
          profiles={activeConfig.profiles}
          profileName={activeProfile?.name ?? ""}
          onDelete={() => updateDraft((c) => deleteAppMapping(c, editingMapping.id))}
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
