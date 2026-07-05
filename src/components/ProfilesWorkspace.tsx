import { Fragment, startTransition, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmModalRequest } from "./ConfirmModal";
import type { AppConfig, AppMapping, ControlId, Device, Layer, Profile } from "../lib/config";
import type { FamilySection, ViewState } from "../lib/constants";
import type { ExecutionRecord, WindowCaptureResult } from "../lib/runtime";
import { open } from "@tauri-apps/plugin-dialog";
import { deleteDeviceImage, importDeviceImage } from "../lib/backend";
import {
  addLearnedControl,
  applyBindingImport,
  copyBindingBetweenProfiles,
  createDevice,
  keepBindingDisableOthers,
  copyBindingFromLayer,
  createAppMapping,
  createAppMappingFromCapture,
  deleteAppMapping,
  duplicateBinding,
  findDuplicateAppMapping,
  importProfile,
  placeDeviceHotspot,
  removeBinding,
  removeBindingsForControls,
  removeControl,
  removeDevice,
  renameDevice,
  setDeviceImage,
  reorderAppMappingPriority,
  moveAppMappingToProfile,
  upsertAppMapping,
  upsertBinding,
} from "../lib/config-editing";
import { useActionPicker } from "../hooks/useActionPicker";
import { useMouseVisualPanel } from "../hooks/useMouseVisualPanel";
import { exportProfileToFile, importProfileFromFile } from "../lib/profile-transfer";
import { exportBindingToFile, importBindingFromFile } from "../lib/binding-transfer";
import {
  bindingMatchesQuery,
  conflictingBindingIds,
  findShortcutConflicts,
} from "../lib/conflict-detection";
import { sortAppMappings, toggleInSet } from "../lib/helpers";
import { displayNameForControl } from "../lib/labels";
import { ContextMenu } from "./ContextMenu";
import { AddControlModal } from "./AddControlModal";
import { DeviceBar } from "./DeviceBar";
import { GenericDeviceView } from "./GenericDeviceView";
import { MouseVisualization } from "./MouseVisualization";
import { Notice, Toggle } from "./shared";
import { ExeIcon } from "./ExeIcon";
import { AppMappingModal } from "./AppMappingModal";
import { CaptureControls } from "./CaptureControls";

export interface ProfilesWorkspaceProps {
  activeConfig: AppConfig;
  activeProfile: Profile | null;
  effectiveProfileId: string | null;
  addRuleSignal: boolean;
  onAddRuleHandled: () => void;
  quickRuleCapture: WindowCaptureResult | null;
  onQuickRuleHandled: () => void;
  lastCapture: WindowCaptureResult | null;
  captureDelayMs: number;
  viewState: ViewState;
  updateDraft: (updateConfig: (config: AppConfig) => AppConfig) => void;
  setCaptureDelayMs: (ms: number) => void;
  setConfirmModal: (modal: ConfirmModalRequest | null) => void;
  handleCaptureActiveWindow: () => Promise<void>;
  setProfileSyncSuppressed: (suppressed: boolean) => void;
  familySections: FamilySection[];
  devices: Device[];
  activeDeviceId: string | null;
  onSelectDevice: (id: string) => void;
  selectedLayer: Layer;
  multiSelectedControlIds: Set<ControlId>;
  onSelectLayer: (layer: Layer) => void;
  setSelectedProfileId: (id: string | null) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
  executionCounts?: Map<string, number>;
  executionHistory?: Map<string, ExecutionRecord[]>;
  throttledControlIds?: Set<string>;
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
  quickRuleCapture,
  onQuickRuleHandled,
  lastCapture,
  captureDelayMs,
  viewState,
  updateDraft,
  setCaptureDelayMs,
  setConfirmModal,
  handleCaptureActiveWindow,
  setProfileSyncSuppressed,
  familySections,
  devices,
  activeDeviceId,
  onSelectDevice,
  selectedLayer,
  multiSelectedControlIds,
  onSelectLayer,
  setSelectedProfileId,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
  executionCounts,
  executionHistory,
  throttledControlIds,
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

  // ── Devices ──
  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? devices[0] ?? null;
  const [addControlOpen, setAddControlOpen] = useState(false);

  function handleAddDevice() {
    const { config: nextConfig, deviceId } = createDevice(activeConfig, t("device.defaultName"));
    updateDraft(() => nextConfig);
    onSelectDevice(deviceId);
    showToast(t("device.created"), "success");
  }

  function handleCreateControl(name: string, encodedKey: string) {
    if (!activeDevice) return;
    const { config: nextConfig, controlId } = addLearnedControl(
      activeConfig,
      activeDevice.id,
      name,
      encodedKey,
    );
    updateDraft(() => nextConfig);
    setSelectedControlId(controlId);
    setAddControlOpen(false);
    showToast(t("device.controlCreated"), "success");
  }

  function handleRemoveControl(controlId: ControlId) {
    const control = activeConfig.physicalControls.find((entry) => entry.id === controlId);
    setConfirmModal({
      title: t("device.deleteControlTitle"),
      message: t("device.deleteControlMessage", { name: control?.defaultName ?? controlId }),
      confirmLabel: t("device.delete"),
      danger: true,
      onConfirm: () => {
        updateDraft((config) => removeControl(config, controlId));
        setSelectedControlId(null);
      },
    });
  }

  function handleDeleteDevice() {
    if (!activeDevice || activeDevice.builtin || devices.length <= 1) return;
    const deviceId = activeDevice.id;
    const image = activeDevice.image;
    setConfirmModal({
      title: t("device.deleteTitle"),
      message: t("device.deleteMessage", { name: activeDevice.name }),
      confirmLabel: t("device.delete"),
      danger: true,
      onConfirm: () => {
        const fallback = devices.find((device) => device.id !== deviceId);
        updateDraft((config) => removeDevice(config, deviceId));
        setSelectedControlId(null);
        if (fallback) onSelectDevice(fallback.id);
        // Best-effort file cleanup; the config no longer references it.
        if (image) void deleteDeviceImage(image).catch(() => {});
      },
    });
  }

  async function handlePickImage() {
    if (!activeDevice) return;
    const path = await open({
      title: t("device.pickPhotoTitle"),
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
        { name: "All files", extensions: ["*"] },
      ],
      multiple: false,
    });
    if (typeof path !== "string") return;
    const deviceId = activeDevice.id;
    const previous = activeDevice.image;
    try {
      const fileName = await importDeviceImage(path);
      updateDraft((config) => setDeviceImage(config, deviceId, fileName));
      if (previous) void deleteDeviceImage(previous).catch(() => {});
    } catch {
      showToast(t("device.photoImportError"), "warning");
    }
  }

  // Export one binding to a portable .sidearm-binding.json file.
  async function handleExportBinding(bindingId: string) {
    const binding = activeConfig.bindings.find((b) => b.id === bindingId);
    // menu actions reference child actions by id; the single-binding format
    // doesn't carry those children, so block transfer rather than ship a
    // dangling-reference file. ponytail: deep child-cloning deferred.
    const action = binding ? activeConfig.actions.find((a) => a.id === binding.actionId) : null;
    if (action?.type === "menu") {
      showToast(t("binding.transferMenuBlocked"), "warning");
      return;
    }
    const name = (binding?.label?.trim() || "binding").replace(/[^\w.-]+/g, "-").toLowerCase();
    try {
      const ok = await exportBindingToFile(activeConfig, bindingId, t("binding.exportTitle"), name);
      if (ok) showToast(t("binding.exported"), "success");
    } catch {
      showToast(t("binding.exportError"), "warning");
    }
  }

  // Import a binding from a file onto a target control (with a preview confirm).
  async function handleImportBinding(controlId: ControlId) {
    if (!effectiveProfileId) return;
    let result;
    try {
      result = await importBindingFromFile(t("binding.importTitle"));
    } catch {
      showToast(t("binding.importError"), "warning");
      return;
    }
    if (result.status === "cancelled") return;
    if (result.status === "invalid") {
      showToast(t("binding.importInvalid"), "warning");
      return;
    }
    const { data } = result;
    setConfirmModal({
      title: t("binding.importTitle"),
      message: t("binding.importConfirm", {
        action: data.action.displayName,
        snippets: data.referencedSnippets.length,
      }),
      confirmLabel: t("binding.importConfirmLabel"),
      onConfirm: () => {
        try {
          updateDraft((c) => applyBindingImport(c, data, effectiveProfileId, selectedLayer, controlId));
          showToast(t("binding.imported"), "success");
        } catch {
          // Defense-in-depth: the structural guard above rejects the realistic
          // malformed files, but a payload that's well-shaped yet inconsistent
          // could still throw here — surface it instead of a broken draft.
          showToast(t("binding.importError"), "warning");
        }
        setConfirmModal(null);
      },
    });
  }

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
  // All-rules view: list every profile's app rules, grouped by profile, instead
  // of only the active profile's. Clicking a foreign card switches to its profile.
  const [allProfilesView, setAllProfilesView] = useState(false);

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

  // Conflict merge: keep one binding enabled, disable the rest of its group.
  const handleKeepBinding = (
    bindingIds: string[],
    keepBindingId: string,
    keptLabel: string,
  ) => {
    updateDraft((c) => keepBindingDisableOthers(c, bindingIds, keepBindingId));
    showToast(
      t("conflict.kept", { label: keptLabel, count: bindingIds.length - 1 }),
      "success",
    );
  };

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

  const profilesById = useMemo(
    () => new Map(activeConfig.profiles.map((p) => [p.id, p])),
    [activeConfig.profiles],
  );

  // All-rules view groups every profile's rules in profile-list order, each
  // group sorted by priority via sortAppMappings (same as the per-profile view).
  const displayedAppMappings = useMemo(
    () =>
      allProfilesView
        ? activeConfig.profiles.flatMap((p) =>
            sortAppMappings(activeConfig.appMappings.filter((m) => m.profileId === p.id)),
          )
        : selectedAppMappings,
    [allProfilesView, activeConfig.profiles, activeConfig.appMappings, selectedAppMappings],
  );

  const editingMapping =
    activeConfig.appMappings.find((mapping) => mapping.id === editingMappingId) ?? null;
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

  // Quick-rule from the tray: a window was already captured (no countdown), so
  // open the create-rule dialog prefilled with its exe/path/title.
  useEffect(() => {
    if (!quickRuleCapture || !activeProfile) return;
    const cap = quickRuleCapture;
    // Don't clobber an already-open create-rule draft with unsaved edits: only
    // prefill when no draft is currently open (functional update keeps the
    // existing one). The tray capture is still consumed either way.
    setCreatingDraft(
      (prev) =>
        prev ?? {
          id: "",
          exe: cap.exe,
          processPath: cap.processPath || undefined,
          titleIncludes: cap.title ? [cap.title] : undefined,
          profileId: activeProfile.id,
          enabled: true,
          priority: activeProfile.priority,
        },
    );
    onQuickRuleHandled();
  }, [quickRuleCapture, activeProfile]);

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
        <span className="search-field">
          <svg className="search-field__icon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="profiles-workspace__search"
            placeholder={t("profile.searchPlaceholder")}
            aria-label={t("profile.searchPlaceholder")}
            value={bindingSearch}
            onChange={(e) => setBindingSearch(e.target.value)}
          />
          {bindingSearch.length > 0 && (
            <button
              type="button"
              className="search-field__clear"
              aria-label={t("common.clearSearch")}
              onClick={() => setBindingSearch("")}
            >
              ×
            </button>
          )}
        </span>
        {searchQuery && !searchAllProfiles && matchedControlIds ? (
          <span className="profiles-workspace__search-meta">
            {t("profile.searchMeta", { count: matchedControlIds.size })}
          </span>
        ) : null}
        <button
          type="button"
          className={`action-button action-button--small${searchAllProfiles ? " action-button--active" : ""}`}
          aria-pressed={searchAllProfiles}
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
                      setBindingSearch("");
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
            {layerConflicts.map((g) => {
              const bindingIds = g.bindings.map((b) => b.bindingId);
              return (
                <li key={`${g.layer}:${g.signature}`}>
                  {t("conflict.group", {
                    signature: g.signature,
                    controls: g.bindings.map((b) => b.label).join(", "),
                  })}
                  <span className="profiles__conflict-actions">
                    {g.bindings.map((b) => (
                      <button
                        key={b.bindingId}
                        type="button"
                        className="profiles__conflict-keep"
                        onClick={() =>
                          handleKeepBinding(bindingIds, b.bindingId, b.label)
                        }
                      >
                        {t("conflict.keepThis", { label: b.label })}
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </Notice>
      ) : null}

      {/* ── Bulk actions for a multi-control selection ── */}
      {multiSelectedControlIds.size > 1 ? (
        <div className="profiles__bulk-bar" role="toolbar" aria-label={t("bulk.label")}>
          <span className="profiles__bulk-count">
            {t("bulk.selected", { count: multiSelectedControlIds.size })}
          </span>
          <button
            type="button"
            className="action-button action-button--small action-button--danger"
            onClick={() => {
              if (!effectiveProfileId) return;
              const profileId = effectiveProfileId;
              const controlIds = multiSelectedControlIds;
              const removed = removeBindingsForControls(
                activeConfig,
                profileId,
                selectedLayer,
                controlIds,
              ).removed;
              if (removed === 0) {
                showToast(t("bulk.nothingToClear"), "info");
                return;
              }
              setConfirmModal({
                title: t("bulk.clearTitle"),
                message: t("bulk.clearMessage", { count: removed }),
                confirmLabel: t("bulk.clearConfirm"),
                danger: true,
                onConfirm: () => {
                  updateDraft(
                    (c) => removeBindingsForControls(c, profileId, selectedLayer, controlIds).config,
                  );
                  setMultiSelectedControlIds(new Set());
                  showToast(t("bulk.cleared", { count: removed }), "success");
                },
              });
            }}
          >
            {t("bulk.clear")}
          </button>
          <button
            type="button"
            className="action-button action-button--small"
            onClick={() => setMultiSelectedControlIds(new Set())}
          >
            {t("bulk.deselect")}
          </button>
        </div>
      ) : null}

      {/* ── Mouse visualization ── */}
      <div className="profiles__mouse-viz">
        <DeviceBar
          devices={devices}
          activeDeviceId={activeDevice?.id ?? null}
          onSelect={onSelectDevice}
          onAdd={handleAddDevice}
        />
        {activeDevice && !activeDevice.builtin ? (
          <GenericDeviceView
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
            executionHistory={executionHistory}
            throttledControlIds={throttledControlIds}
            heatmapEnabled={heatmapEnabled}
            onDropBinding={handleDropBinding}
            device={activeDevice}
            onAddControl={() => setAddControlOpen(true)}
            onRemoveControl={handleRemoveControl}
            onRenameDevice={(name) => updateDraft((config) => renameDevice(config, activeDevice.id, name))}
            onDeleteDevice={handleDeleteDevice}
            onPickImage={() => void handlePickImage()}
            onPlaceHotspot={(controlId, x, y) =>
              updateDraft((config) => placeDeviceHotspot(config, activeDevice.id, controlId, x, y))
            }
          />
        ) : (
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
            executionHistory={executionHistory}
            throttledControlIds={throttledControlIds}
            heatmapEnabled={heatmapEnabled}
            onDropBinding={handleDropBinding}
          />
        )}
        {addControlOpen && activeDevice ? (
          <AddControlModal
            config={activeConfig}
            deviceName={activeDevice.name}
            onClose={() => setAddControlOpen(false)}
            onCreate={handleCreateControl}
          />
        ) : null}
        <div className="heatmap-toggle">
          <button
            type="button"
            className={`action-button action-button--small${heatmapEnabled ? " action-button--active" : ""}`}
            aria-pressed={heatmapEnabled}
            onClick={() => setHeatmapEnabled((prev) => !prev)}
            title={`${heatmapEnabled ? t("profile.heatmapDisable") : t("profile.heatmapEnable")} · ${t("profile.heatmapTooltip")}`}
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
        <span className="profiles__section-count">{displayedAppMappings.length}</span>
        <button
          type="button"
          className={`action-button action-button--small${allProfilesView ? " action-button--active" : ""}`}
          aria-pressed={allProfilesView}
          onClick={() => setAllProfilesView((v) => !v)}
        >
          {t("profile.allProfilesToggle")}
        </button>
      </div>

      {/* ── Card grid ── */}
      <div className="profiles__card-grid">
        {displayedAppMappings.map((mapping, index) => {
          const isActive = editingMapping?.id === mapping.id;
          const isDisabled = !mapping.enabled;
          const isDragging = draggingMappingId === mapping.id;
          const isDragOver = dragOverMappingId === mapping.id && draggingMappingId !== mapping.id;
          // Same-profile neighbours for keyboard reorder (Alt+Arrow). Groups are
          // contiguous and priority-sorted, so a neighbour in the same profile is
          // just the adjacent card that shares its profileId.
          const prevSameProfile =
            index > 0 && displayedAppMappings[index - 1].profileId === mapping.profileId
              ? displayedAppMappings[index - 1]
              : null;
          const nextSameProfile =
            index < displayedAppMappings.length - 1 &&
            displayedAppMappings[index + 1].profileId === mapping.profileId
              ? displayedAppMappings[index + 1]
              : null;
          // In all-rules view, stamp a profile subheader before the first card of
          // each profile group (rows are flat; the header spans the full grid row).
          const showGroupHeader =
            allProfilesView &&
            (index === 0 || displayedAppMappings[index - 1].profileId !== mapping.profileId);
          return (
            <Fragment key={mapping.id}>
            {showGroupHeader ? (
              <h4 className="profiles__group-header">
                {profilesById.get(mapping.profileId)?.name ?? mapping.profileId}
              </h4>
            ) : null}
            <button
              type="button"
              draggable
              className={`profiles__app-card${isActive ? " profiles__app-card--active" : ""}${isDisabled ? " profiles__app-card--disabled" : ""}${isDragging ? " profiles__app-card--dragging" : ""}${isDragOver ? " profiles__app-card--drag-over" : ""}`}
              onClick={() => {
                // Editing a foreign-profile card switches to its profile first so
                // the editor (scoped to the active profile) resolves the mapping.
                if (mapping.profileId !== effectiveProfileId) setSelectedProfileId(mapping.profileId);
                setEditingMappingId(mapping.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setRuleCtxMenu({ x: e.clientX, y: e.clientY, mappingId: mapping.id });
              }}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onKeyDown={(e) => {
                // Keyboard reorder: Alt+Arrow moves the rule within its profile
                // group. The card keeps its focus because React keys by mapping.id.
                if (!e.altKey) return;
                if (e.key === "ArrowUp" && prevSameProfile) {
                  e.preventDefault();
                  updateDraft((c) => reorderAppMappingPriority(c, mapping.id, prevSameProfile.id));
                } else if (e.key === "ArrowDown" && nextSameProfile) {
                  e.preventDefault();
                  updateDraft((c) => reorderAppMappingPriority(c, mapping.id, nextSameProfile.id));
                }
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
                const dragged = draggingMappingId
                  ? activeConfig.appMappings.find((m) => m.id === draggingMappingId)
                  : null;
                setDraggingMappingId(null);
                setDragOverMappingId(null);
                if (!dragged || dragged.id === mapping.id) return;
                if (dragged.profileId === mapping.profileId) {
                  updateDraft((c) =>
                    reorderAppMappingPriority(c, dragged.id, mapping.id),
                  );
                  return;
                }
                // Cross-profile move (only reachable in all-rules view) — re-homes
                // the rule to another profile, so confirm before committing.
                const toName =
                  profilesById.get(mapping.profileId)?.name ?? mapping.profileId;
                setConfirmModal({
                  title: t("profile.moveTitle"),
                  message: t("profile.moveConfirm", {
                    exe: dragged.exe,
                    from: profilesById.get(dragged.profileId)?.name ?? dragged.profileId,
                    to: toName,
                  }),
                  confirmLabel: t("profile.moveConfirmLabel"),
                  onConfirm: () => {
                    updateDraft((c) =>
                      moveAppMappingToProfile(c, dragged.id, mapping.id),
                    );
                    showToast(t("profile.moved", { to: toName }), "success");
                    setConfirmModal(null);
                  },
                });
              }}
              onDragEnd={() => {
                setDraggingMappingId(null);
                setDragOverMappingId(null);
              }}
            >
              <ExeIcon exe={mapping.exe} processPath={mapping.processPath} className="profiles__app-card-monogram" />
              <span className="profiles__app-card-body">
                <span className="profiles__app-card-name">{mapping.exe.replace(/\.exe$/i, "")}</span>
                <span className="profiles__app-card-meta">{t("profile.cardMeta", { count: activeConfig.bindings.filter((b) => b.profileId === mapping.profileId).length, priority: mapping.priority })}</span>
              </span>
              <span
                className="profiles__toggle-wrap"
                onClick={(e) => e.stopPropagation()}
              >
                <Toggle
                  checked={mapping.enabled}
                  ariaLabel={mapping.enabled ? t("common.disabled") : t("common.enabled")}
                  onChange={(checked) =>
                    updateDraft((c) => upsertAppMapping(c, { ...mapping, enabled: checked }))
                  }
                />
              </span>
            </button>
            </Fragment>
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

      {displayedAppMappings.length === 0 && activeProfile ? (
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
        const targetIdx = selectedAppMappings.findIndex((m) => m.id === targetMapping.id);
        const moveUpTarget = targetIdx > 0 ? selectedAppMappings[targetIdx - 1] : null;
        const moveDownTarget =
          targetIdx < selectedAppMappings.length - 1 ? selectedAppMappings[targetIdx + 1] : null;
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
                label: t("profile.moveUp"),
                disabled: !moveUpTarget,
                onClick: () => {
                  if (moveUpTarget)
                    updateDraft((c) =>
                      reorderAppMappingPriority(c, targetMapping.id, moveUpTarget.id),
                    );
                },
              },
              {
                label: t("profile.moveDown"),
                disabled: !moveDownTarget,
                onClick: () => {
                  if (moveDownTarget)
                    updateDraft((c) =>
                      reorderAppMappingPriority(c, targetMapping.id, moveDownTarget.id),
                    );
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
        // menu bindings reference child actions by id that cross-profile copy
        // doesn't carry/clone, so block their transfer (see handleExportBinding).
        const isMenuBinding =
          !!binding && activeConfig.actions.find((a) => a.id === binding.actionId)?.type === "menu";
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
              // Copy to another profile (same button/layer). ponytail: flat items —
              // fine for the usual 2-4 profiles; swap for a picker modal if it grows.
              ...activeConfig.profiles
                .filter((p) => p.id !== effectiveProfileId)
                .map((p) => ({
                  label: t("assignments.copyToProfile", { profile: p.name }),
                  disabled: !binding,
                  onClick: () => {
                    if (!binding) return;
                    if (isMenuBinding) {
                      showToast(t("binding.transferMenuBlocked"), "warning");
                      return;
                    }
                    updateDraft((c) =>
                      copyBindingBetweenProfiles(c, binding.id, p.id, selectedLayer, cid),
                    );
                    showToast(t("assignments.copiedToProfile", { profile: p.name }), "success");
                  },
                })),
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
                label: t("binding.exportItem"),
                disabled: !binding,
                onClick: () => {
                  if (binding) void handleExportBinding(binding.id);
                },
              },
              {
                label: t("binding.importItem"),
                disabled: !effectiveProfileId,
                onClick: () => {
                  void handleImportBinding(cid);
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
