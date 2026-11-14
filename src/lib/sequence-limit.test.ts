import { expect, it } from "vitest";
import schema from "../../schemas/config.v5.schema.json";
import { MAX_SEQUENCE_STEPS } from "./config";

it("caps sequences at the schema's step limit (Rust config::MAX_SEQUENCE_STEPS checks the same)", () => {
  expect(schema.$defs.sequenceActionPayload.properties.steps.maxItems).toBe(MAX_SEQUENCE_STEPS);
});
