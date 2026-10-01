import { afterEach, describe, expect, it } from "vitest";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../features/sessions/model/models";
import { catalogModel, transcriptTurnModel } from "./externalTranscript";

describe("catalogModel", () => {
  afterEach(() => resetHarnessModelOverlays());

  it("finds a dated model the CLI lists under a moving alias", () => {
    setHarnessModels("claude", [
      {
        id: "claude:sonnet",
        harness: "claude",
        name: "Sonnet 5",
        nativeId: "sonnet",
      },
      {
        id: "claude:haiku",
        harness: "claude",
        name: "Haiku 4.5",
        nativeId: "haiku",
      },
    ]);
    expect(catalogModel("claude", "claude-haiku-4-5-20251001")).toMatchObject({
      id: "claude:haiku",
      name: "Haiku 4.5",
    });
    expect(
      transcriptTurnModel("claude", "claude-haiku-4-5-20251001").name,
    ).toBe("Haiku 4.5");
  });

  it("never maps to a different version of the same family", () => {
    setHarnessModels("claude", [
      {
        id: "claude:haiku",
        harness: "claude",
        name: "Haiku 5",
        nativeId: "haiku",
      },
    ]);
    expect(catalogModel("claude", "claude-haiku-4-5-20251001")).toBeUndefined();
    // Still named from the bundled catalog, not as a raw id.
    expect(
      transcriptTurnModel("claude", "claude-haiku-4-5-20251001").name,
    ).toBe("Haiku 4.5");
  });
});
