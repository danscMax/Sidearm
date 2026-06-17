import {
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

type CssVarValue = string | number | undefined;

/**
 * Apply CSS custom properties to a DOM/SVG node via the CSSOM (FIXES P2-3).
 *
 * CSP `style-src` without `'unsafe-inline'` blocks every inline `style="..."`
 * attribute, including React `style={{ "--x": v }}` objects (they still render
 * to a `style` attribute). Properties set through the CSSOM
 * (`element.style.setProperty`) are NOT gated by CSP, so this is the CSP-safe
 * way to push computed values into CSS.
 *
 * Use it only for genuinely continuous/computed values (percent positions,
 * `translateX` offsets, counts, font sizes). For discrete on/off states prefer
 * a conditional `className` instead.
 *
 * Returns a stable ref to attach to the target element. Values are (re)applied
 * in a layout effect (pre-paint, so there is no flash) whenever any value
 * changes; keys whose value is `undefined`/`null` are removed.
 */
export function useCssVars<T extends HTMLElement | SVGElement = HTMLElement>(
  vars: Record<string, CssVarValue>,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Names set on the previous run, so keys that vanish entirely from `vars`
  // (not just turned undefined/null) still get removed from the element.
  const prevKeysRef = useRef<string[]>([]);
  // Serialize so the effect re-runs only when the values actually change,
  // independent of the object identity React hands us on every render.
  const serialized = JSON.stringify(vars);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Remove properties for keys that are no longer present in `vars`.
    for (const name of prevKeysRef.current) {
      if (!(name in vars)) {
        el.style.removeProperty(name);
      }
    }
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined || value === null) {
        el.style.removeProperty(name);
      } else {
        el.style.setProperty(name, String(value));
      }
    }
    prevKeysRef.current = Object.keys(vars);
    // `vars` is intentionally tracked via its serialized form (`serialized`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  return ref;
}
