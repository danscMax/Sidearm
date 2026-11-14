/**
 * Shared inline action icons. Extracted to kill the duplicated copy/export/trash
 * SVGs that were inlined at two sizes in SettingsWorkspace (and had already
 * drifted — one copy filled the back square, the other didn't). Size is a prop.
 */

interface IconProps {
  size?: number;
}

/** A fold mark: points right, and down when `open` (turned by `.chevron--open`). */
export function ChevronIcon({ size = 12, open = false }: IconProps & { open?: boolean }) {
  return (
    <svg className={`chevron${open ? " chevron--open" : ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect
        x="1"
        y="5"
        width="10"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="var(--c-surface-alt)"
      />
    </svg>
  );
}

export function ExportIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1v9M5 7l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ImportIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M8 10V1M5 4l3-3 3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 11v2a2 2 0 002 2h8a2 2 0 002-2v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6 7.33v4M10 7.33v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The snippet library: two books on a shelf. */
export function LibraryIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 2.5h3v11h-3zM7 2.5h3v11H7zM10.8 3.4l2.4-.6 1.9 9.6-2.4.6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** The action picker's category glyphs (16 px line icons); a category without
 *  one (the HyperShift roles) shows its `fallback` letters. */
export function CategoryIcon({ id, fallback, size = 16 }: { id: string; fallback: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    native: <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v3h3" />,
    shortcut: (
      <>
        <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
        <path d="M4 6.5h1M7 6.5h1M10 6.5h1M4.5 9.5h7" />
      </>
    ),
    mouseAction: (
      <>
        <rect x="4" y="1.5" width="8" height="13" rx="4" />
        <path d="M8 1.5v4.5" />
      </>
    ),
    textSnippet: <path d="M3 3h10M8 3v10M5.5 13h5" />,
    sequence: <path d="M2 4h7M2 8h7M2 12h5M11 9.5l3 2-3 2z" />,
    launch: <path d="M9.5 2H14v4.5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />,
    mediaKey: (
      <>
        <path d="M6 12V3l7-1.5V10" />
        <circle cx="4.5" cy="12" r="1.8" />
        <circle cx="11.5" cy="10.5" r="1.8" />
      </>
    ),
    profileSwitch: <path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5" />,
    menu: <path d="M2 3.5h1M5.5 3.5H14M2 8h1M5.5 8H14M2 12.5h1M5.5 12.5H14" />,
    disabled: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="m3.8 12.2 8.4-8.4" />
      </>
    ),
    repairClipboard: (
      <>
        <rect x="3" y="2.5" width="10" height="12" rx="1.5" />
        <path d="M6 2.5h4v2H6zM5.5 8.5l1.8 1.8 3.2-3.3" />
      </>
    ),
    stopMacros: (
      <>
        <circle cx="8" cy="8" r="6" />
        <rect x="5.5" y="5.5" width="5" height="5" rx="0.8" />
      </>
    ),
    cheatSheet: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" />
      </>
    ),
  };
  const drawn = paths[id];
  if (!drawn) return <>{fallback}</>;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {drawn}
    </svg>
  );
}
