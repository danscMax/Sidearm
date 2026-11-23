import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId, Device } from "../lib/config";
import { normalizeKeyName, resolveKeyName } from "../lib/action-picker-helpers";
import { cancelRawInputCapture, captureNextRawInput } from "../lib/backend";
import { findMappingByEncodedKey } from "../lib/config-editing";
import { displayNameForControl } from "../lib/labels";
import { ModalFooter, ModalHeader, ModalShell, Notice } from "./shared";
import { CaptureRow } from "./action-picker/shared/CaptureRow";

export interface EditControlTarget {
  controlId: ControlId;
  name: string;
  signal: string;
}

export interface RawDeviceSelection {
  id: string;
  label: string;
}

/** Learn mode: name a control and capture any mouse button or key directly via
 * Windows Raw Input (recording both the canonical signal and the hardware
 * USB VID/PID so Sidearm can isolate that device without touching the main
 * keyboard). Falls back to DOM key capture in non-Windows/test environments. */
export function AddControlModal({
  config,
  device,
  autoName,
  editTarget,
  onClose,
  onSubmit,
}: {
  config: AppConfig;
  device: Device;
  /** Suggested name for the next control ("Button N") — placeholder + fallback. */
  autoName: string;
  /** When set, the modal edits this control instead of creating one. */
  editTarget?: EditControlTarget;
  onClose: () => void;
  /** andNext is only ever true in create mode. */
  onSubmit: (
    name: string,
    encodedKey: string,
    andNext: boolean,
    rawDevice?: RawDeviceSelection | null,
  ) => void;
}) {
  const { t } = useTranslation();
  const isEdit = !!editTarget;
  const [name, setName] = useState(editTarget?.name ?? "");
  const [signal, setSignal] = useState(editTarget?.signal ?? "");
  const [capturing, setCapturing] = useState(false);
  const [detectedRaw, setDetectedRaw] = useState<RawDeviceSelection | null>(
    device.rawDeviceId
      ? { id: device.rawDeviceId, label: device.rawDeviceLabel ?? device.rawDeviceId }
      : null,
  );
  const [scopeToHardware, setScopeToHardware] = useState(true);
  // True while Rust Raw Input is actively waiting for hardware input so DOM
  // keydown does not race ahead and discard the USB VID/PID.
  const rawCaptureActiveRef = useRef(false);

  useEffect(() => {
    if (!capturing) {
      rawCaptureActiveRef.current = false;
      return;
    }
    let cancelled = false;
    rawCaptureActiveRef.current = true;
    captureNextRawInput(15_000)
      .then((captured) => {
        rawCaptureActiveRef.current = false;
        if (cancelled) return;
        if (captured) {
          setSignal(captured.encodedKey);
          if (captured.rawDeviceId) {
            setDetectedRaw({
              id: captured.rawDeviceId,
              label: captured.rawDeviceLabel ?? captured.rawDeviceId,
            });
            setScopeToHardware(true);
          }
        }
        setCapturing(false);
      })
      .catch(() => {
        // Non-Tauri / browser / mock mode: fall back to DOM keyboard capture.
        rawCaptureActiveRef.current = false;
      });
    return () => {
      cancelled = true;
      rawCaptureActiveRef.current = false;
      void cancelRawInputCapture().catch(() => {});
    };
  }, [capturing]);

  const effectiveRaw = scopeToHardware ? detectedRaw : null;
  const duplicateMapping = signal
    ? findMappingByEncodedKey(config, signal, effectiveRaw?.id ?? device.rawDeviceId ?? null)
    : undefined;
  // Re-capturing a control's own signal is not a conflict (edit mode).
  const duplicate =
    duplicateMapping && duplicateMapping.controlId !== editTarget?.controlId
      ? duplicateMapping
      : undefined;
  const duplicateControl = duplicate
    ? config.physicalControls.find((control) => control.id === duplicate.controlId)
    : undefined;
  const duplicateDevice = duplicateControl
    ? config.devices.find((entry) => entry.id === duplicateControl.deviceId)
    : undefined;
  const canSubmit = signal.trim().length > 0 && !duplicate;

  function handleKeyCapture(event: ReactKeyboardEvent) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const key = resolveKeyName(event);
    if (key === "Escape") {
      setCapturing(false);
      return;
    }
    // While native Raw Input capture is active, let it deliver both signal and USB VID/PID.
    if (rawCaptureActiveRef.current) return;
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;
    // Sidearm's own injected hook-probe key (VK 0xE8) — see ShortcutEditor.
    if (key === "VK_232") return;
    // Canonical modifier order matches the Rust hotkey normalizer (Ctrl, Alt,
    // Shift, Win) so the saved encodedKey round-trips unchanged.
    const parts = [
      event.ctrlKey ? "Ctrl" : null,
      event.altKey ? "Alt" : null,
      event.shiftKey ? "Shift" : null,
      event.metaKey ? "Win" : null,
      normalizeKeyName(key),
    ].filter((part): part is string => part !== null);
    setSignal(parts.join("+"));
    setCapturing(false);
  }

  function submit(andNext: boolean) {
    onSubmit(name.trim() || autoName, signal, andNext, effectiveRaw);
    if (andNext) {
      // Batch teaching: stay open, arm the next capture immediately (U2).
      setName("");
      setSignal("");
      setCapturing(true);
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      className="confirm-modal add-control-modal"
      ariaLabelledby="add-control-title"
      escapeEnabled={!capturing}
      onKeyDown={handleKeyCapture}
    >
      <ModalHeader
        id="add-control-title"
        title={isEdit ? t("device.editControlTitle") : t("device.addControlTitle")}
        subtitle={device.name}
        onClose={onClose}
        closeLabel={t("common.close")}
      />
      <label className="field">
        <span className="field__label">{t("device.controlName")}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={autoName}
          maxLength={40}
        />
      </label>
      <label className="field">
        <span className="field__label">{t("device.signal")}</span>
        <CaptureRow
          ariaLabel={t("device.signal")}
          value={signal}
          placeholder={capturing ? t("device.signalCapturing") : t("device.signalEmpty")}
          capturing={capturing}
          onToggle={() => setCapturing(!capturing)}
          recordLabel={t("device.record")}
        />
      </label>
      {detectedRaw ? (
        <div className="add-control-modal__usb">
          <div className="add-control-modal__usb-badge">
            {t("device.rawDeviceDetected", { label: detectedRaw.label })}
          </div>
          <label className="add-control-modal__usb-toggle">
            <input
              type="checkbox"
              checked={scopeToHardware}
              onChange={(e) => setScopeToHardware(e.target.checked)}
            />
            <span>{t("device.scopeToDevice")}</span>
          </label>
        </div>
      ) : null}
      <p className="panel__muted">{t("device.captureHint")}</p>
      {duplicate ? (
        <Notice variant="warning" id="add-control-dup-warning">
          {t("device.signalDuplicate", {
            signal: duplicate.encodedKey,
            control: duplicateControl ? displayNameForControl(duplicateControl) : duplicate.controlId,
            device: duplicateDevice?.name ?? "?",
          })}
        </Notice>
      ) : null}
      <ModalFooter>
        <button type="button" className="action-button" onClick={onClose}>
          {t("common.cancel")}
        </button>
        {!isEdit ? (
          <button
            type="button"
            className="action-button"
            disabled={!canSubmit}
            aria-describedby={duplicate ? "add-control-dup-warning" : undefined}
            onClick={() => submit(true)}
          >
            {t("device.createAndNext")}
          </button>
        ) : null}
        <button
          type="button"
          className="action-button action-button--accent"
          disabled={!canSubmit}
          aria-describedby={duplicate ? "add-control-dup-warning" : undefined}
          onClick={() => submit(false)}
        >
          {isEdit ? t("common.save") : t("device.create")}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
