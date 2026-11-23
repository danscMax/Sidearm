import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Device } from "../lib/config";
import { normalizeKeyName, resolveKeyName } from "../lib/action-picker-helpers";
import { cancelRawInputCapture, captureNextRawInput, readDeviceImage } from "../lib/backend";
import { findMappingByEncodedKey } from "../lib/config-editing";
import {
  DEVICE_PRESETS,
  defaultHotspotForControl,
  friendlyNameForSignal,
  isPresetDeviceImage,
  type DevicePresetId,
} from "../lib/device-presets";
import { buildHotspotTooltip } from "../lib/labels";
import { actionLabel, type MouseVisualizationProps, type TriggerBadgeLabels } from "../lib/mouse-visual";
import { useControlInteractions } from "../hooks/useControlInteractions";
import type { RawDeviceSelection } from "./AddControlModal";
import { ContextMenu } from "./ContextMenu";
import { DevicePresetArt } from "./DevicePresetArt";
import { LegendCell } from "./mouse-visual/LegendCell";
import { LayerPills } from "./mouse-visual/LayerPills";

const HOTSPOT_DRAG_MIME = "application/x-sidearm-hotspot";

interface GenericDeviceViewProps extends MouseVisualizationProps {
  config?: AppConfig;
  device: Device;
  signalsByControlId?: ReadonlyMap<ControlId, string>;
  onAddControl: () => void;
  onQuickLearnControl?: (
    name: string,
    encodedKey: string,
    rawDevice?: RawDeviceSelection | null,
    initialHotspot?: { x: number; y: number } | null,
  ) => void;
  onEditControl: (id: ControlId) => void;
  onRemoveControl: (id: ControlId) => void;
  onRenameDevice: (name: string) => void;
  onDeleteDevice: () => void;
  onClearRawDevice?: () => void;
  onPickImage: () => void;
  onSelectPresetImage?: (preset: DevicePresetId) => void;
  onClearImage?: () => void;
  onPlaceHotspot: (controlId: ControlId, x: number, y: number) => void;
  /** One-shot: open the inline rename with focus (just-created device, U10). */
  startRenaming?: boolean;
  onStartRenamingHandled?: () => void;
}

/** Universal custom-device studio: combines a live USB Raw Input learning radar
 *  (no modal per button), selectable built-in hardware schematics or uploaded
 *  photos, and drag-and-drop hotspot placement directly on the schematic. */
export function GenericDeviceView({
  config,
  entries,
  signalsByControlId,
  selectedLayer,
  multiSelectedControlIds,
  matchedControlIds,
  conflictBindingIds,
  onSelectControl,
  onToggleMultiSelect,
  onOpenActionPicker,
  onSelectLayer,
  onCopyLayer,
  onContextMenu,
  executionCounts,
  executionHistory,
  heatmapEnabled,
  onDropBinding,
  device,
  onAddControl,
  onQuickLearnControl,
  onEditControl,
  onRemoveControl,
  onRenameDevice,
  onDeleteDevice,
  onClearRawDevice,
  onPickImage,
  onSelectPresetImage,
  onClearImage,
  onPlaceHotspot,
  startRenaming,
  onStartRenamingHandled,
}: GenericDeviceViewProps) {
  const { t, i18n } = useTranslation();
  const isRussian = i18n.language.toLowerCase().startsWith("ru");
  const isEmpty = entries.length === 0;

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name);
  const [radarOpen, setRadarOpen] = useState(isEmpty);
  const [radarArmed, setRadarArmed] = useState(false);
  const [scopeToUsb, setScopeToUsb] = useState(true);
  const [radarNote, setRadarNote] = useState<string | null>(null);
  const [showGraphics, setShowGraphics] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [draggingHotspotId, setDraggingHotspotId] = useState<ControlId | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const rawLoopActiveRef = useRef(false);
  const justDraggedRef = useRef(false);
  const pointerDragRef = useRef<{
    controlId: ControlId;
    startX: number;
    startY: number;
    moved: boolean;
    lastX: number;
    lastY: number;
  } | null>(null);

  // Keep fresh references for the continuous Raw Input loop so it never closes
  // over stale config, device, or callbacks across consecutive presses.
  const latestRef = useRef({
    config,
    device,
    entries,
    scopeToUsb,
    isRussian,
    onQuickLearnControl,
    onSelectControl,
  });
  latestRef.current = {
    config,
    device,
    entries,
    scopeToUsb,
    isRussian,
    onQuickLearnControl,
    onSelectControl,
  };

  // Reset per-device local UI when switching between custom devices.
  useEffect(() => {
    setNameDraft(device.name);
    setEditingName(false);
    setRadarNote(null);
    setOverflowMenu(null);
    const emptyNow = entries.length === 0;
    setRadarOpen(emptyNow);
    setRadarArmed(false);
    setShowGraphics(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on device switch
  }, [device.id]);

  // A just-created device drops straight into naming it (UI-review U10).
  useEffect(() => {
    if (startRenaming) {
      setNameDraft(device.name);
      setEditingName(true);
      onStartRenamingHandled?.();
    }
  }, [startRenaming, device.name, onStartRenamingHandled]);

  const presetId: DevicePresetId | null = isPresetDeviceImage(device.image) ? device.image : null;

  // Load user-uploaded photos via backend data: URL; built-in SVG presets render inline.
  useEffect(() => {
    let cancelled = false;
    if (!device.image || isPresetDeviceImage(device.image)) {
      setImageUrl(null);
      return;
    }
    readDeviceImage(device.image)
      .then((url) => {
        if (!cancelled) setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [device.image]);

  const hasSchematic = Boolean(presetId || imageUrl);

  function handleLearnedSignal(encodedKey: string, rawDevice?: RawDeviceSelection | null) {
    const cur = latestRef.current;
    const effectiveRaw = cur.scopeToUsb ? (rawDevice ?? null) : null;
    const scopeId = effectiveRaw?.id ?? cur.device.rawDeviceId ?? null;
    const existing = cur.config
      ? findMappingByEncodedKey(cur.config, encodedKey, scopeId)
      : undefined;
    if (existing && cur.config) {
      const existingCtrl = cur.config.physicalControls.find((c) => c.id === existing.controlId);
      setRadarNote(
        t("device.radarAlreadyAdded", {
          name: existingCtrl?.defaultName ?? existing.controlId,
          signal: existing.encodedKey,
        }),
      );
      if (existingCtrl?.deviceId === cur.device.id) {
        cur.onSelectControl(existing.controlId);
      }
      return;
    }
    const nextIndex = cur.entries.length + 1;
    const autoLabel = friendlyNameForSignal(
      encodedKey,
      t("device.autoName", { n: nextIndex }),
      cur.isRussian,
    );
    const initialHotspot = cur.device.image
      ? defaultHotspotForControl(cur.device.image, encodedKey, cur.entries.length)
      : null;
    cur.onQuickLearnControl?.(autoLabel, encodedKey, effectiveRaw, initialHotspot);
    setRadarNote(t("device.radarCaught", { name: autoLabel, signal: encodedKey }));
  }

  // Automatically pause the learning radar whenever the Sidearm window loses
  // focus or is hidden, so `SUPPRESS_EXECUTION` never stays on while using other apps.
  useEffect(() => {
    if (!radarArmed) return;
    const pause = () => setRadarArmed(false);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") setRadarArmed(false);
    };
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [radarArmed]);

  // Continuous Windows Raw Input learning loop while the radar is armed.
  useEffect(() => {
    if (!radarOpen || !radarArmed || editingName) {
      rawLoopActiveRef.current = false;
      return;
    }
    let cancelled = false;
    rawLoopActiveRef.current = true;

    async function runLoop() {
      while (!cancelled) {
        try {
          const captured = await captureNextRawInput(15_000);
          if (cancelled) break;
          if (!captured) {
            // Idle 15s timeout or external cancel: keep listening until stopped.
            continue;
          }
          const rawDev = captured.rawDeviceId
            ? {
                id: captured.rawDeviceId,
                label: captured.rawDeviceLabel ?? captured.rawDeviceId,
              }
            : null;
          handleLearnedSignal(captured.encodedKey, rawDev);
          // Brief pause so React commits the newly added control before the next capture.
          await new Promise((resolve) => setTimeout(resolve, 60));
        } catch {
          // Non-Tauri / browser / mock mode: leave radar armed for DOM keydown fallback.
          rawLoopActiveRef.current = false;
          break;
        }
      }
    }

    void runLoop();
    return () => {
      cancelled = true;
      rawLoopActiveRef.current = false;
      void cancelRawInputCapture().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads fresh state via latestRef
  }, [radarOpen, radarArmed, editingName, device.id]);

  // DOM keyboard fallback when running outside Tauri + Escape to pause radar cleanly.
  useEffect(() => {
    if (!radarOpen || !radarArmed || editingName) return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setRadarArmed(false);
        return;
      }
      if (rawLoopActiveRef.current) {
        event.preventDefault();
        return;
      }
      const key = resolveKeyName(event as unknown as React.KeyboardEvent);
      if (["Control", "Shift", "Alt", "Meta", "VK_232"].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      const parts = [
        event.ctrlKey ? "Ctrl" : null,
        event.altKey ? "Alt" : null,
        event.shiftKey ? "Shift" : null,
        event.metaKey ? "Win" : null,
        normalizeKeyName(key),
      ].filter((part): part is string => part !== null);
      handleLearnedSignal(parts.join("+"), null);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads fresh state via latestRef
  }, [radarOpen, radarArmed, editingName]);

  const interaction = useControlInteractions({
    entries,
    onSelectControl,
    onToggleMultiSelect,
    onOpenActionPicker,
    onContextMenu,
    onDropBinding,
    executionCounts,
    heatmapEnabled,
  });
  const { entryMap, hoveredId, dragOverId, getInteractionProps, applyHeatBg } = interaction;
  const triggerLabels: TriggerBadgeLabels = {
    hold: t("visualization.badgeHold"),
    chord: t("visualization.badgeChord"),
  };

  function commitName() {
    setEditingName(false);
    if (nameDraft.trim() && nameDraft.trim() !== device.name) {
      onRenameDevice(nameDraft);
    } else {
      setNameDraft(device.name);
    }
  }

  function percentCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const clamp = (v: number) => Math.round(Math.min(96, Math.max(4, v)) * 10) / 10;
    return {
      x: clamp(((clientX - rect.left) / rect.width) * 100),
      y: clamp(((clientY - rect.top) / rect.height) * 100),
    };
  }

  // --- Direct pointer drag for hotspots already on the schematic ---
  function handleHotspotPointerDown(controlId: ControlId, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const coords = percentCoords(event.clientX, event.clientY) ?? { x: 50, y: 50 };
    pointerDragRef.current = {
      controlId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      lastX: coords.x,
      lastY: coords.y,
    };
  }

  function handleHotspotPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && dist < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      setDraggingHotspotId(drag.controlId);
    }
    const coords = percentCoords(event.clientX, event.clientY);
    if (!coords) return;
    drag.lastX = coords.x;
    drag.lastY = coords.y;
    event.currentTarget.style.setProperty("--hotspot-left", `${coords.x}%`);
    event.currentTarget.style.setProperty("--hotspot-top", `${coords.y}%`);
  }

  function handleHotspotPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    setDraggingHotspotId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag?.moved) {
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
      onPlaceHotspot(drag.controlId, drag.lastX, drag.lastY);
    }
  }

  // --- Drag-and-drop from the recognized button chips onto the schematic ---
  function handleStageDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(HOTSPOT_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!dropActive) setDropActive(true);
  }

  function handleStageDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropActive(false);
    }
  }

  function handleStageDrop(event: ReactDragEvent<HTMLDivElement>) {
    const controlId = event.dataTransfer.getData(HOTSPOT_DRAG_MIME);
    setDropActive(false);
    if (!controlId) return;
    event.preventDefault();
    const coords = percentCoords(event.clientX, event.clientY);
    if (!coords) return;
    onPlaceHotspot(controlId, coords.x, coords.y);
    onSelectControl(controlId);
  }

  function startChipHotspotDrag(controlId: ControlId, event: ReactDragEvent) {
    event.dataTransfer.setData(HOTSPOT_DRAG_MIME, controlId);
    event.dataTransfer.effectAllowed = "copyMove";
  }

  const placedIds = new Set((device.hotspots ?? []).map((hotspot) => hotspot.controlId));

  function renderHotspots() {
    return (device.hotspots ?? []).map((hotspot) => {
      const entry = entryMap.get(hotspot.controlId);
      if (!entry) return null;
      const index = entries.indexOf(entry);
      const isAssigned =
        entry.binding && entry.binding.enabled && entry.action && entry.action.type !== "disabled";
      const assignedClass = isAssigned
        ? ` mouse-visual__hotspot--assigned mouse-visual__hotspot--type-${entry.action?.type}`
        : " mouse-visual__hotspot--unassigned";
      const isSelected = entry.isSelected || multiSelectedControlIds.has(entry.control.id);
      const isDimmed = matchedControlIds != null && !matchedControlIds.has(entry.control.id);
      const hasConflict = !!entry.binding && (conflictBindingIds?.has(entry.binding.id) ?? false);
      const isDragging = draggingHotspotId === entry.control.id;
      const baseProps = getInteractionProps(entry.control.id);
      return (
        <button
          type="button"
          key={hotspot.controlId}
          className={`mouse-visual__hotspot gdv__hotspot${
            isSelected ? " mouse-visual__hotspot--selected" : assignedClass
          }${hoveredId === entry.control.id ? " mouse-visual__hotspot--hovered" : ""}${
            dragOverId === entry.control.id ? " mouse-visual__hotspot--dragover" : ""
          }${isDimmed ? " mouse-visual__hotspot--dimmed" : ""}${
            hasConflict ? " mouse-visual__hotspot--conflict" : ""
          }${isDragging ? " gdv__hotspot--dragging" : ""}`}
          ref={(el) => {
            if (el && !isDragging) {
              el.style.setProperty("--hotspot-left", `${hotspot.x}%`);
              el.style.setProperty("--hotspot-top", `${hotspot.y}%`);
            }
            applyHeatBg(el, entry.control.id);
          }}
          title={`${entry.control.defaultName} (${signalsByControlId?.get(entry.control.id) ?? ""}) — ${t("device.hotspotDragHint")}\n${buildHotspotTooltip(
            entry,
            selectedLayer,
            executionHistory?.get(entry.control.id),
            executionCounts?.get(entry.control.id) ?? 0,
          )}`}
          onPointerDown={(e) => handleHotspotPointerDown(entry.control.id, e)}
          onPointerMove={handleHotspotPointerMove}
          onPointerUp={handleHotspotPointerUp}
          onPointerCancel={handleHotspotPointerUp}
          onMouseEnter={baseProps.onMouseEnter}
          onMouseLeave={baseProps.onMouseLeave}
          onContextMenu={baseProps.onContextMenu}
          onClick={(e) => {
            if (justDraggedRef.current) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            baseProps.onClick(e);
          }}
          onDoubleClick={(e) => {
            if (justDraggedRef.current) return;
            baseProps.onDoubleClick(e);
          }}
        >
          {index + 1}
        </button>
      );
    });
  }

  return (
    <div className="mouse-visual-tabs gdv gdv--studio" data-layer={selectedLayer}>
      {/* ── Calm single-row studio header ── */}
      <div className="gdv__header">
        <div className="gdv__title-cluster">
          {editingName ? (
            <input
              type="text"
              className="input gdv__name-input"
              aria-label={t("settings.deviceNameHeader")}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") {
                  setNameDraft(device.name);
                  setEditingName(false);
                }
              }}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit rename click
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="gdv__name-btn"
              title={t("device.rename")}
              onClick={() => {
                setNameDraft(device.name);
                setEditingName(true);
              }}
            >
              <span className="gdv__name">{device.name}</span>
              <span className="gdv__name-edit-icon" aria-hidden="true">✎</span>
            </button>
          )}

          {device.rawDeviceId ? (
            <div className="gdv__usb-row gdv__usb-row--bound">
              <span className="gdv__usb-dot" aria-hidden="true" />
              <span className="gdv__usb-pill" title={device.rawDeviceId}>
                {t("device.rawDeviceBound", { label: device.rawDeviceLabel ?? device.rawDeviceId })}
              </span>
              {onClearRawDevice ? (
                <button
                  type="button"
                  className="gdv__usb-clear"
                  title={t("device.unlinkRawDeviceHint", { id: device.rawDeviceId })}
                  aria-label={t("device.unlinkRawDevice")}
                  onClick={onClearRawDevice}
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : radarOpen ? (
            <div className="gdv__usb-row gdv__usb-row--waiting">
              <span className="gdv__usb-dot" aria-hidden="true" />
              <span className="gdv__usb-pill">{t("device.usbWaiting")}</span>
            </div>
          ) : null}
        </div>

        <div className="gdv__header-actions">
          <button
            type="button"
            className={`action-button action-button--small${radarOpen && radarArmed ? " action-button--accent" : ""}`}
            onClick={() => {
              if (!radarOpen) {
                setRadarOpen(true);
                setRadarArmed(true);
              } else {
                setRadarArmed((prev) => !prev);
              }
            }}
          >
            {radarOpen && radarArmed ? t("device.radarPauseBtn") : t("device.radarLearnBtn")}
          </button>
          <button
            type="button"
            className={`action-button action-button--small${showGraphics ? " action-button--active" : ""}`}
            aria-pressed={showGraphics}
            onClick={() => setShowGraphics((prev) => !prev)}
          >
            {t("device.graphicsBtn")}
          </button>
          <button
            type="button"
            className="action-button action-button--small gdv__more-btn"
            aria-label={t("device.moreActions")}
            title={t("device.moreActions")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setOverflowMenu({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
            ⋯
          </button>
        </div>
      </div>

      {/* ── Visual schematic / graphic preset selector ── */}
      {showGraphics || isEmpty ? (
        <div className="gdv__presets" role="group" aria-label={t("device.graphicsLabel")}>
          {DEVICE_PRESETS.map((preset) => {
            const active = device.image === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`gdv__preset-card${active ? " gdv__preset-card--active" : ""}`}
                aria-pressed={active}
                onClick={() => onSelectPresetImage?.(preset.id)}
              >
                <DevicePresetArt preset={preset.id} compact />
                <span className="gdv__preset-label">{t(preset.labelKey)}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={`gdv__preset-card${imageUrl ? " gdv__preset-card--active" : ""}`}
            onClick={onPickImage}
          >
            <span className="gdv__preset-ico" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="9" cy="10" r="1.6" fill="currentColor" />
                <path d="M5 17l5-5 3.5 3.5L16 13l3 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="gdv__preset-label">
              {imageUrl ? t("device.replacePhoto") : t("device.uploadPhotoShort")}
            </span>
          </button>
          {device.image ? (
            <button
              type="button"
              className="gdv__preset-card gdv__preset-card--clear"
              onClick={() => onClearImage?.()}
            >
              <span className="gdv__preset-ico" aria-hidden="true">×</span>
              <span className="gdv__preset-label">{t("device.noSchematic")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ── Live USB Raw Input Learning Radar ── */}
      {radarOpen ? (
        <div className={`gdv__radar${radarArmed ? " gdv__radar--armed" : ""}`}>
          <div className="gdv__radar-main">
            <button
              type="button"
              className="gdv__orb"
              aria-pressed={radarArmed}
              title={radarArmed ? t("device.radarPauseBtn") : t("device.radarResumeBtn")}
              onClick={() => setRadarArmed((prev) => !prev)}
            >
              <span className="gdv__orb-core" aria-hidden="true">{radarArmed ? "◉" : "▶"}</span>
            </button>
            <div className="gdv__radar-copy">
              <h4 className="gdv__radar-title">
                {radarArmed
                  ? isEmpty
                    ? t("device.radarListeningTitle")
                    : t("device.radarListeningCount", { count: entries.length })
                  : t("device.radarPausedTitle")}
              </h4>
              <p className="gdv__radar-sub">{t("device.radarSub")}</p>
              {radarNote ? (
                <p className="gdv__radar-note" role="status">{radarNote}</p>
              ) : null}
            </div>
          </div>

          <div className="gdv__radar-foot">
            <label className="gdv__radar-toggle">
              <input
                type="checkbox"
                checked={scopeToUsb}
                onChange={(e) => setScopeToUsb(e.target.checked)}
              />
              <span>{t("device.scopeToDevice")}</span>
            </label>
            <div className="gdv__radar-foot-actions">
              <button
                type="button"
                className="action-button action-button--small"
                onClick={() => {
                  setRadarArmed(false);
                  onAddControl();
                }}
              >
                {t("device.addManually")}
              </button>
              {!isEmpty ? (
                <button
                  type="button"
                  className="action-button action-button--small action-button--accent"
                  onClick={() => {
                    setRadarArmed(false);
                    setRadarOpen(false);
                    setShowGraphics(false);
                  }}
                >
                  {t("device.radarDone")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Interactive Schematic Canvas (Preset SVG or Uploaded Photo) ── */}
      {hasSchematic ? (
        <div className="gdv__stage-wrap">
          <div
            ref={stageRef}
            className={`mouse-visual gdv__photo gdv__stage${dropActive ? " gdv__stage--drop-active" : ""}`}
            onDragOver={handleStageDragOver}
            onDragLeave={handleStageDragLeave}
            onDrop={handleStageDrop}
          >
            {presetId ? (
              <DevicePresetArt preset={presetId} />
            ) : imageUrl ? (
              <img className="mouse-visual__img" src={imageUrl} alt={device.name} draggable={false} />
            ) : null}
            <div className="mouse-visual__overlay">{renderHotspots()}</div>
          </div>
          {entries.length > 0 ? (
            <p className="panel__muted gdv__stage-hint">
              {!radarOpen && entries.some((e) => !e.action || e.action.type === "disabled" || !e.binding?.enabled)
                ? `${t("device.dragToSchematicHint")}. ${t("device.gridHint")}`
                : t("device.dragToSchematicHint")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Recognized Buttons Grid ── */}
      {entries.length > 0 ? (
        <>
          {!radarOpen && !hasSchematic &&
          entries.some(
            (entry) => !entry.action || entry.action.type === "disabled" || !entry.binding?.enabled,
          ) ? (
            <p className="panel__muted gdv__grid-hint">{t("device.gridHint")}</p>
          ) : null}
          <div className="gdv__grid">
            {entries.map((entry, index) => {
              const controlId = entry.control.id;
              const selected = entry.isSelected || multiSelectedControlIds.has(controlId);
              const dimmed = matchedControlIds != null && !matchedControlIds.has(controlId);
              const conflict = !!entry.binding && (conflictBindingIds?.has(entry.binding.id) ?? false);
              const sig = signalsByControlId?.get(controlId);
              const isPlaced = placedIds.has(controlId);
              const isAssigned =
                entry.action && entry.action.type !== "disabled" && entry.binding?.enabled;
              return (
                <div
                  key={controlId}
                  className="gdv__cell"
                  draggable={hasSchematic && !isAssigned}
                  onDragStart={(e) => {
                    if (hasSchematic && !isAssigned) startChipHotspotDrag(controlId, e);
                  }}
                >
                  <LegendCell
                    entry={entry}
                    controlId={controlId}
                    interaction={interaction}
                    selected={selected}
                    badge={String(index + 1)}
                    label={
                      isAssigned
                        ? `${entry.control.defaultName} (${sig ?? ""}): ${actionLabel(entry, { triggerLabels })}`
                        : sig
                          ? `${entry.control.defaultName} (${sig})`
                          : entry.control.defaultName
                    }
                    tooltip={buildHotspotTooltip(
                      entry,
                      selectedLayer,
                      executionHistory?.get(controlId),
                      executionCounts?.get(controlId) ?? 0,
                    )}
                    nativeTooltip
                    dimmed={dimmed}
                    conflict={conflict}
                    executionCounts={executionCounts}
                    heatmapEnabled={heatmapEnabled}
                  />
                  {hasSchematic ? (
                    <span
                      className={`gdv__cell-pin${isPlaced ? " gdv__cell-pin--placed" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        startChipHotspotDrag(controlId, e);
                      }}
                      title={t("device.dragChipToSchematic")}
                      aria-label={t("device.dragChipToSchematic")}
                    >
                      ⋮⋮
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="gdv__cell-remove gdv__cell-edit"
                    title={t("device.editControlTitle")}
                    aria-label={t("device.editControlTitle")}
                    onClick={() => onEditControl(controlId)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="gdv__cell-remove"
                    title={t("device.deleteControl")}
                    aria-label={t("device.deleteControl", { name: entry.control.defaultName })}
                    onClick={() => onRemoveControl(controlId)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {entries.length > 0 ? (
        <LayerPills selectedLayer={selectedLayer} onSelectLayer={onSelectLayer} onCopyLayer={onCopyLayer} neutralLabels />
      ) : null}

      {overflowMenu ? (
        <ContextMenu
          x={overflowMenu.x}
          y={overflowMenu.y}
          onClose={() => setOverflowMenu(null)}
          items={[
            {
              label: t("device.rename"),
              onClick: () => {
                setNameDraft(device.name);
                setEditingName(true);
              },
            },
            {
              label: t("device.addManually"),
              onClick: () => {
                setRadarArmed(false);
                onAddControl();
              },
            },
            {
              label: imageUrl ? t("device.replacePhoto") : t("device.addPhoto"),
              onClick: onPickImage,
            },
            ...(device.image && onClearImage
              ? [{ label: t("device.noSchematic"), onClick: onClearImage }]
              : []),
            null,
            {
              label: t("device.delete"),
              danger: true,
              onClick: onDeleteDevice,
            },
          ]}
        />
      ) : null}
    </div>
  );
}
