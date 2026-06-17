import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCssVars } from "./useCssVars";

afterEach(() => {
  document.body.replaceChildren();
});

/** Render the hook against a div attached to the document and return both the
 *  element and a rerender helper that pushes a new `vars` object. */
function setup(initial: Record<string, string | number | undefined>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const { result, rerender } = renderHook(
    (vars: Record<string, string | number | undefined>) => {
      const ref = useCssVars<HTMLDivElement>(vars);
      ref.current = el;
      return ref;
    },
    { initialProps: initial },
  );
  return { el, result, rerender };
}

describe("useCssVars", () => {
  it("sets custom properties from values", () => {
    const { el } = setup({ "--a": 5, "--b": "10px" });
    expect(el.style.getPropertyValue("--a")).toBe("5");
    expect(el.style.getPropertyValue("--b")).toBe("10px");
  });

  it("removes a property when its value becomes undefined", () => {
    const { el, rerender } = setup({ "--a": 5 });
    expect(el.style.getPropertyValue("--a")).toBe("5");
    rerender({ "--a": undefined });
    expect(el.style.getPropertyValue("--a")).toBe("");
  });

  // Audit F011: a key that disappears entirely from `vars` (not just turned
  // undefined) used to linger on the element forever. It must be removed.
  it("removes a property when its key disappears from the object", () => {
    const { el, rerender } = setup({ "--a": 5 });
    expect(el.style.getPropertyValue("--a")).toBe("5");
    rerender({});
    expect(el.style.getPropertyValue("--a")).toBe("");
  });

  it("keeps surviving keys while removing the vanished one", () => {
    const { el, rerender } = setup({ "--a": 5, "--b": 7 });
    rerender({ "--b": 9 });
    expect(el.style.getPropertyValue("--a")).toBe("");
    expect(el.style.getPropertyValue("--b")).toBe("9");
  });
});
