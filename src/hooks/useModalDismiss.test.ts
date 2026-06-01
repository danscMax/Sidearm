import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useModalDismiss } from "./useModalDismiss";

/** Build a container with two focusable buttons, attached to the document. */
function makeContainer(): HTMLDivElement {
  const container = document.createElement("div");
  const first = document.createElement("button");
  first.textContent = "first";
  const last = document.createElement("button");
  last.textContent = "last";
  container.append(first, last);
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useModalDismiss — Escape handling", () => {
  it("calls onClose on Escape keydown", () => {
    const onClose = vi.fn();
    const ref: RefObject<HTMLElement | null> = { current: null };
    renderHook(() => useModalDismiss(ref, { onClose }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when escapeEnabled is false", () => {
    const onClose = vi.fn();
    const ref: RefObject<HTMLElement | null> = { current: null };
    renderHook(() => useModalDismiss(ref, { onClose, escapeEnabled: false }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores non-Escape keys", () => {
    const onClose = vi.fn();
    const ref: RefObject<HTMLElement | null> = { current: null };
    renderHook(() => useModalDismiss(ref, { onClose }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the window listener on unmount", () => {
    const onClose = vi.fn();
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { unmount } = renderHook(() => useModalDismiss(ref, { onClose }));

    unmount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useModalDismiss — Tab focus trap", () => {
  it("ignores non-Tab keys in the returned handler", () => {
    const ref: RefObject<HTMLElement | null> = { current: makeContainer() };
    const { result } = renderHook(() => useModalDismiss(ref, { onClose: vi.fn() }));

    const preventDefault = vi.fn();
    result.current({ key: "Enter", shiftKey: false, preventDefault } as unknown as ReactKeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("is a no-op when the container ref is null", () => {
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useModalDismiss(ref, { onClose: vi.fn() }));

    const preventDefault = vi.fn();
    result.current({ key: "Tab", shiftKey: false, preventDefault } as unknown as ReactKeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("wraps Tab from the last element back to the first", () => {
    const container = makeContainer();
    const ref: RefObject<HTMLElement | null> = { current: container };
    const { result } = renderHook(() => useModalDismiss(ref, { onClose: vi.fn() }));
    const buttons = container.querySelectorAll("button");
    (buttons[buttons.length - 1] as HTMLElement).focus();

    const preventDefault = vi.fn();
    result.current({ key: "Tab", shiftKey: false, preventDefault } as unknown as ReactKeyboardEvent);

    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("wraps Shift+Tab from the first element back to the last", () => {
    const container = makeContainer();
    const ref: RefObject<HTMLElement | null> = { current: container };
    const { result } = renderHook(() => useModalDismiss(ref, { onClose: vi.fn() }));
    const buttons = container.querySelectorAll("button");
    (buttons[0] as HTMLElement).focus();

    const preventDefault = vi.fn();
    result.current({ key: "Tab", shiftKey: true, preventDefault } as unknown as ReactKeyboardEvent);

    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });
});
