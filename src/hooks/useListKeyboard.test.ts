import { describe, it, expect, vi } from "vitest";
import { useListKeyboard, type UseListKeyboardOptions } from "./useListKeyboard";

function fakeKey(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

function setup(opts: Partial<UseListKeyboardOptions>) {
  const setActiveIndex = vi.fn();
  const onSelect = vi.fn();
  const handler = useListKeyboard({
    itemCount: 3,
    activeIndex: 0,
    setActiveIndex,
    onSelect,
    ...opts,
  });
  return { handler, setActiveIndex, onSelect };
}

/** Apply the functional updater passed to setActiveIndex against `prev`. */
function resultFrom(setActiveIndex: ReturnType<typeof vi.fn>, prev: number) {
  return setActiveIndex.mock.calls[0][0](prev);
}

describe("useListKeyboard", () => {
  it("clamps ArrowDown at the last index", () => {
    const { handler, setActiveIndex } = setup({});
    handler(fakeKey("ArrowDown"));
    expect(resultFrom(setActiveIndex, 0)).toBe(1);
    expect(resultFrom(setActiveIndex, 2)).toBe(2); // clamped, count = 3
  });

  it("clamps ArrowUp at the first index", () => {
    const { handler, setActiveIndex } = setup({});
    handler(fakeKey("ArrowUp"));
    expect(resultFrom(setActiveIndex, 0)).toBe(0);
    expect(resultFrom(setActiveIndex, 2)).toBe(1);
  });

  it("wraps around the ends when wrap is true", () => {
    const down = setup({ wrap: true });
    down.handler(fakeKey("ArrowDown"));
    expect(resultFrom(down.setActiveIndex, 2)).toBe(0); // 2 -> 0

    const up = setup({ wrap: true });
    up.handler(fakeKey("ArrowUp"));
    expect(resultFrom(up.setActiveIndex, 0)).toBe(2); // 0 -> 2
  });

  it("Home jumps to 0 and End to the last index", () => {
    const home = setup({});
    home.handler(fakeKey("Home"));
    expect(resultFrom(home.setActiveIndex, 2)).toBe(0);

    const end = setup({});
    end.handler(fakeKey("End"));
    expect(resultFrom(end.setActiveIndex, 0)).toBe(2);
  });

  it("Enter selects the active index", () => {
    const { handler, onSelect } = setup({ activeIndex: 1 });
    handler(fakeKey("Enter"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("Enter is a no-op when the active index is out of range", () => {
    const { handler, onSelect } = setup({ activeIndex: -1 });
    handler(fakeKey("Enter"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", () => {
    const { handler, setActiveIndex, onSelect } = setup({ itemCount: 0 });
    const ev = fakeKey("ArrowDown");
    handler(ev);
    expect(setActiveIndex).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("calls preventDefault on navigation keys", () => {
    const { handler } = setup({});
    const ev = fakeKey("ArrowDown");
    handler(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
  });
});
