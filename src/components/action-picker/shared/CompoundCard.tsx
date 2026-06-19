import type { ReactNode } from "react";

/** A titled card with a delete action and an `editor-grid` body. Shared by the
 *  conditions and sequence-step lists (`stack-list` of these). */
export function CompoundCard({
  title,
  meta,
  removeLabel,
  onRemove,
  canRemove = true,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  removeLabel: string;
  onRemove: () => void;
  /** When false, the delete button is disabled. Default true. */
  canRemove?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="compound-card">
      <div className="compound-card__header">
        <div>
          <strong>{title}</strong>
          {meta != null ? <span className="compound-card__meta">{meta}</span> : null}
        </div>
        <button
          type="button"
          className="action-button action-button--secondary action-button--small"
          disabled={!canRemove}
          onClick={onRemove}
        >
          {removeLabel}
        </button>
      </div>
      <div className="editor-grid">{children}</div>
    </div>
  );
}
