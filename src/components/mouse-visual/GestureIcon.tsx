// Monochrome marks of a button's other press patterns (and of "needs
// Sidearm", "kept alike on the other mouse"), drawn in the current text colour:
// a press held (a dot with a trail), two or three taps (two or three dots), no
// Sidearm (a broken ring), synced (two chain links), the same on another button
// (two overlapping squares).

type Mark = "longPress" | "doublePress" | "triplePress" | "live" | "link" | "copy";

export function GestureIcon({ mark }: { mark: Mark }) {
  return (
    <svg className="gesture-icon" viewBox="0 0 16 10" width="16" height="10" aria-hidden="true" focusable="false">
      {mark === "longPress" ? (
        <>
          <circle cx="3.5" cy="5" r="2.6" fill="currentColor" />
          <rect x="6.8" y="4" width="8" height="2" rx="1" fill="currentColor" opacity="0.6" />
        </>
      ) : mark === "link" ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="2.5" width="8" height="5" rx="2.5" />
          <rect x="7" y="2.5" width="8" height="5" rx="2.5" />
        </g>
      ) : mark === "copy" ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="0.75" width="6.5" height="6" rx="1.5" />
          <rect x="6.5" y="3.25" width="6.5" height="6" rx="1.5" />
        </g>
      ) : mark === "live" ? (
        <path d="M8 1.5a3.5 3.5 0 1 1-3.3 2.3M8 1.5V0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        (mark === "doublePress" ? [5, 11] : [3, 8, 13]).map((x) => <circle key={x} cx={x} cy="5" r="2.1" fill="currentColor" />)
      )}
    </svg>
  );
}
