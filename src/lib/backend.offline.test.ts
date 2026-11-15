import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getOfflinePreview } from "./backend";
import { makeConfig } from "./test-fixtures";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("sends the exact frozen preview command and returns its planner result", async () => {
  const config = makeConfig();
  const preview = { target: { state: "unknown" }, controls: [] };
  vi.mocked(invoke).mockResolvedValueOnce(preview);
  expect(await getOfflinePreview(config, "p1", "razer-naga")).toBe(preview);
  expect(invoke).toHaveBeenCalledWith("get_offline_preview", { config, profileId: "p1", deviceId: "razer-naga" });
});
