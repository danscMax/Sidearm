import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, ControlId } from "../lib/config";
import { normalizeKeyName, resolveKeyName } from "../lib/action-picker-helpers";
import { findMappingByEncodedKey } from "../lib/config-editing";
import { displayNameForControl } from "../lib/labels";
import { ModalFooter, ModalHeader, ModalShell, Notice } from "./shared";
import { CaptureRow } from "./action-picker/shared/CaptureRow";

export interface EditControlTarget {
  controlId: ControlId;
  name: string;
  signal: string;
}

/** Learn mode: name a control and capture the key signal its hardware button
 * sends. Capture happens in the DOM (like the shortcut recorder) — the
 * low-level hook only intercepts already-mapped signals, so a brand-new
 * button's keystroke reaches this window as a plain keydown.
 * Doubles as the EDIT dialog for an existing control (rename + re-capture,
 * UI-review U1/U3) and supports "add & next" batch teaching (U2). */
export function AddControlModal({
  config,
  deviceName,
  autoName,
  editTarget,
  onClose,
  onSubmit,
}: {
  config: AppConfig;
  deviceName: string;
  /** Suggested name for the next control ("Button N") — placeholder + fallback. */
  autoName: string;
  /** When set, the modal edits this control instead of creating one. */
  editTarget?: EditControlTarget;
  onClose: () => void;
  /** andNext is only ever true in create mode. */
  onSubmit: (name: string, encodedKey: string, andNext: boolean) => void;
}) {
  const { t } = useTranslation();
  const isEdit = !!editTarget;
  const [name, setName] = useState(editTarget?.name ?? "");
  const [signal, setSignal] = useState(editTarget?.signal ?? "");
  const [capturing, setCapturing] = useState(false);

  const duplicateMapping = signal ? findMappingByEncodedKey(config, signal) : undefined;
  // Re-capturing a control's own signal is not a conflict (edit mode).
  const duplicate =
    duplicateMapping && duplicateMapping.controlId !== editTarget?.controlId
      ? duplicateMapping
      : undefined;
  const duplicateControl = duplicate
    ? config.physicalControls.find((control) => control.id === duplicate.controlId)
    : undefined;
  const duplicateDevice = duplicateControl
    ? config.devices.find((device) => device.id === duplicateControl.deviceId)
    : undefined;
  const canSubmit = signal.trim().length > 0 && !duplicate;

  function handleKeyCapture(event: ReactKeyboardEvent) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const key = resolveKeyName(event);
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;
    // Sidearm's own injected hook-probe key (VK 0xE8) — see ShortcutEditor.
    if (key === "VK_232") return;
    if (key === "Escape") {
      setCapturing(false);
      return;
    }
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
    onSubmit(name.trim() || autoName, signal, andNext);
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
        subtitle={deviceName}
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
          value={signal}
          placeholder={capturing ? t("device.signalCapturing") : t("device.signalEmpty")}
          capturing={capturing}
          onToggle={() => setCapturing(!capturing)}
          recordLabel={t("device.record")}
        />
      </label>
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
