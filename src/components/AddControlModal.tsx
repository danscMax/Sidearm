import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "../lib/config";
import { normalizeKeyName, resolveKeyName } from "../lib/action-picker-helpers";
import { findMappingByEncodedKey } from "../lib/config-editing";
import { displayNameForControl } from "../lib/labels";
import { ModalFooter, ModalHeader, ModalShell, Notice } from "./shared";
import { CaptureRow } from "./action-picker/shared/CaptureRow";

/** Learn mode: name a new control and capture the key signal its hardware
 * button sends. Capture happens in the DOM (like the shortcut recorder) — the
 * low-level hook only intercepts already-mapped signals, so a brand-new
 * button's keystroke reaches this window as a plain keydown. */
export function AddControlModal({
  config,
  deviceName,
  onClose,
  onCreate,
}: {
  config: AppConfig;
  deviceName: string;
  onClose: () => void;
  onCreate: (name: string, encodedKey: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [signal, setSignal] = useState("");
  const [capturing, setCapturing] = useState(false);

  const duplicate = signal ? findMappingByEncodedKey(config, signal) : undefined;
  const duplicateControl = duplicate
    ? config.physicalControls.find((control) => control.id === duplicate.controlId)
    : undefined;
  const canCreate = signal.trim().length > 0 && !duplicate;

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
        title={t("device.addControlTitle")}
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
          placeholder={t("device.controlNamePlaceholder")}
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
        <Notice variant="warning">
          {t("device.signalDuplicate", {
            signal: duplicate.encodedKey,
            control: duplicateControl ? displayNameForControl(duplicateControl) : duplicate.controlId,
          })}
        </Notice>
      ) : null}
      <ModalFooter>
        <button type="button" className="action-button" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="action-button action-button--accent"
          disabled={!canCreate}
          onClick={() => onCreate(name, signal)}
        >
          {t("device.create")}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
