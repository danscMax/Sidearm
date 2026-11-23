import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ControlId } from "../lib/config";
import { deviceLayout, layoutControlId } from "../lib/devices";
import { NagaV3Bottom } from "./NagaV3Bottom";

interface ControlPreviewPopoverProps {
  controlId: ControlId;
  deviceId: string;
  label: string;
}

const POPOVER_WIDTH = 196;
const POPOVER_HEIGHT = 224;
const VIEWPORT_MARGIN = 12;

/** Wraps a control label so hovering or focusing it previews the physical mouse
 *  model with a glowing marker at that control's exact position. */
export function ControlPreviewPopover({ controlId, deviceId, label }: ControlPreviewPopoverProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const layout = deviceLayout(deviceId);
  const localId = layoutControlId(controlId);
  const combinedSpot = layout?.combined.hotspots[localId];
  const bottomSpot = !combinedSpot ? layout?.bottom?.hotspots[localId] : undefined;
  const spot = combinedSpot ?? bottomSpot;
  const isBottom = Boolean(!combinedSpot && bottomSpot);

  const computeAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const clampedX = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left + rect.width / 2 - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
    );
    const fitsAbove = rect.top >= POPOVER_HEIGHT + VIEWPORT_MARGIN;
    const clampedY = fitsAbove
      ? rect.top - POPOVER_HEIGHT - 8
      : Math.min(rect.bottom + 8, window.innerHeight - POPOVER_HEIGHT - VIEWPORT_MARGIN);
    return { x: Math.round(clampedX), y: Math.round(Math.max(VIEWPORT_MARGIN, clampedY)) };
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(null);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor]);

  if (!spot) {
    return <span className="offline-fix__btn-name">{label}</span>;
  }

  function openPreview() {
    const next = computeAnchor();
    if (next) setAnchor(next);
  }

  function closePreview() {
    setAnchor(null);
  }

  return (
    <>
      <span
        ref={triggerRef}
        className="offline-fix__btn-name offline-fix__btn-trigger"
        tabIndex={0}
        aria-describedby={anchor ? tooltipId : undefined}
        onMouseEnter={openPreview}
        onMouseLeave={closePreview}
        onFocus={openPreview}
        onBlur={closePreview}
      >
        {label}
      </span>
      {anchor && typeof document !== "undefined"
        ? createPortal(
            <div
              id={tooltipId}
              className="control-preview-popover"
              role="tooltip"
              ref={(el) => {
                if (!el) return;
                el.style.setProperty("--popover-x", `${anchor.x}px`);
                el.style.setProperty("--popover-y", `${anchor.y}px`);
              }}
            >
              <div className={`control-preview-popover__stage${isBottom ? " control-preview-popover__stage--bottom" : ""}`}>
                {isBottom ? (
                  <NagaV3Bottom />
                ) : (
                  <img
                    className="control-preview-popover__img"
                    src="/assets/naga-combined.webp"
                    alt=""
                    draggable={false}
                  />
                )}
                <span
                  className="control-preview-popover__marker"
                  aria-hidden="true"
                  ref={(el) => {
                    if (!el) return;
                    el.style.setProperty("--dot-x", `${spot.left}%`);
                    el.style.setProperty("--dot-y", `${spot.top}%`);
                  }}
                />
              </div>
              <span className="control-preview-popover__caption">{label}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
