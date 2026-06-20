import type { ReactNode } from "react";

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
  children,
}: {
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
  return (
    <div className="compound-card">
      <div className="compound-card__header">
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
