import { useState, type ReactNode } from "react";

const CARD_DRAG_TYPE = "application/x-sidearm-card";

/** A titled card with a delete action and an `editor-grid` body. Shared by the
 *  conditions and sequence-step lists (`stack-list` of these). */
export function CompoundCard({
  title,
  meta,
  removeLabel,
  onRemove,
  canRemove = true,
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
  moveUpLabel,
  moveDownLabel,
  reorder,
  children,
}: {
  /** Drag the header onto another card of the list to move this one there. */
  reorder?: { index: number; onMove: (from: number, to: number) => void };
  title: ReactNode;
  meta?: ReactNode;
  removeLabel: string;
  onRemove: () => void;
  /** When false, the delete button is disabled. Default true. */
  canRemove?: boolean;
  /** Reorder handlers. When neither is given, no move buttons render. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** aria-labels for the ↑/↓ buttons (caller translates). */
  moveUpLabel?: string;
  moveDownLabel?: string;
  children: ReactNode;
}) {
  const showMove = onMoveUp != null || onMoveDown != null;
  const [over, setOver] = useState(false);
  const dropProps = reorder
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer.types).includes(CARD_DRAG_TYPE)) return;
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
          setOver(false);
          const from = Number(e.dataTransfer.getData(CARD_DRAG_TYPE));
          if (Number.isInteger(from) && from !== reorder.index) {
            e.preventDefault();
            reorder.onMove(from, reorder.index);
          }
        },
      }
    : {};
  return (
    <div className={`compound-card${over ? " compound-card--drop" : ""}`} {...dropProps}>
      <div
        className={`compound-card__header${reorder ? " compound-card__header--drag" : ""}`}
        draggable={reorder != null}
        onDragStart={reorder ? (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(CARD_DRAG_TYPE, String(reorder.index));
        } : undefined}
      >
        <div>
          <strong>{title}</strong>
          {meta != null ? <span className="compound-card__meta">{meta}</span> : null}
        </div>
        <div className="editor-actions">
          {showMove ? (
            <>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                disabled={!canMoveUp}
                onClick={onMoveUp}
                aria-label={moveUpLabel}
                title={moveUpLabel}
              >
                ↑
              </button>
              <button
                type="button"
                className="action-button action-button--secondary action-button--small"
                disabled={!canMoveDown}
                onClick={onMoveDown}
                aria-label={moveDownLabel}
                title={moveDownLabel}
              >
                ↓
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            disabled={!canRemove}
            onClick={onRemove}
          >
            {removeLabel}
          </button>
        </div>
      </div>
      <div className="editor-grid">{children}</div>
    </div>
  );
}
