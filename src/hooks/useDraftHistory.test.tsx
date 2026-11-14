import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useDraftHistory } from "./useDraftHistory";

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

  it("takes typing in one field in a row as one step", () => {
    const { result } = renderHook(() => useForm());
    act(() => result.current.setName("h"));
    act(() => result.current.setName("he"));
    act(() => result.current.setName("hey"));
    act(() => result.current.history.undo());
    expect(result.current.name).toBe("");
    expect(result.current.history.canUndo).toBe(false);
  });
});
