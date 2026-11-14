import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { createDraftHistoryStore, useDraftHistory } from "./useDraftHistory";

function useForm() {
  const [items, setItems] = useState(["a", "b"]);
  const [name, setName] = useState("");
  const history = useDraftHistory({ items, name }, (snapshot) => { setItems(snapshot.items); setName(snapshot.name); });
  return { items, name, setItems, setName, history };
}

afterEach(() => vi.useRealTimers());

describe("useDraftHistory", () => {
  it("undoes and redoes a move, and a new edit drops the redo", () => {
    const { result } = renderHook(() => useForm());
    expect(result.current.history.canUndo).toBe(false);
    act(() => result.current.setItems(["b", "a"]));
    expect(result.current.history.canUndo).toBe(true);
    act(() => result.current.history.undo());
    expect(result.current.items).toEqual(["a", "b"]);
    expect(result.current.history.canRedo).toBe(true);
    act(() => result.current.history.redo());
    expect(result.current.items).toEqual(["b", "a"]);
    act(() => result.current.history.undo());
    act(() => result.current.setName("x"));
    expect(result.current.history.canRedo).toBe(false);
  });

  it("takes typing in one field in a row as one step, and quick clicks as steps of their own", () => {
    const { result } = renderHook(() => useForm());
    act(() => result.current.setItems(["b", "a"]));
    act(() => result.current.setItems(["a", "b", "c"]));
    act(() => result.current.history.undo());
    expect(result.current.items).toEqual(["b", "a"]); // one click undone, not both
    act(() => result.current.history.undo());
    const field = document.body.appendChild(document.createElement("input"));
    field.focus();
    act(() => result.current.setName("h"));
    act(() => result.current.setName("he"));
    act(() => result.current.setName("hey"));
    act(() => result.current.history.undo());
    expect(result.current.name).toBe("");
    expect(result.current.history.canUndo).toBe(false);
    field.remove();
  });

  it("keeps a shared store across a remount, and a passive key is no step of its own", () => {
    const store = createDraftHistoryStore<{ name: string; base: number }>();
    const use = ({ start, base }: { start: string; base: number }) => {
      const [name, setName] = useState(start);
      const history = useDraftHistory({ name, base }, (snapshot) => setName(snapshot.name), { store, passive: ["base"] });
      return { name, setName, history };
    };
    const first = renderHook(use, { initialProps: { start: "a", base: 1 } });
    first.rerender({ start: "a", base: 2 });
    expect(first.result.current.history.canUndo).toBe(false);
    act(() => first.result.current.setName("b"));
    first.unmount();
    const second = renderHook(use, { initialProps: { start: "c", base: 3 } });
    expect(second.result.current.history.canUndo).toBe(true);
    act(() => second.result.current.history.undo());
    expect(second.result.current.name).toBe("b");
    act(() => second.result.current.history.undo());
    expect(second.result.current.name).toBe("a");
    expect(second.result.current.history.canUndo).toBe(false);
    expect(store.future.map((snapshot) => snapshot.name)).toEqual(["c", "b"]);
  });
});
