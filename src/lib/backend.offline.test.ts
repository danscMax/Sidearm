import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getOfflinePreview, type OfflinePreview } from "./backend";
import { makeConfig } from "./test-fixtures";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("sends the exact frozen preview command and returns its planner result", async () => {
  const config = makeConfig();
  const preview: OfflinePreview = { target: { state: "notWritten", writtenProfileId: "p2", banks: [{ bank: 1, profileId: "p2" }] },
    controls: [{ controlId: "thumb_01", layer: "offline", kind: "silent", editable: true, reason: "actionType", liveActionType: "textSnippet" }] };
  vi.mocked(invoke).mockResolvedValueOnce(preview);
  expect(await getOfflinePreview(config, "p1", "razer-naga")).toBe(preview);
  expect(invoke).toHaveBeenCalledWith("get_offline_preview", { config, profileId: "p1", deviceId: "razer-naga" });
});
