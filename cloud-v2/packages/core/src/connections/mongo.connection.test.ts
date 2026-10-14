import { describe, expect, test } from "bun:test";
import { settleModelBuilds, type ModelRegistry } from "./mongo.connection";

function registry(inits: Record<string, () => Promise<unknown>>): ModelRegistry {
  return {
    modelNames: () => Object.keys(inits),
    model: (name) => ({ init: inits[name]! }),
  };
}

describe("settleModelBuilds", () => {
  test("waits for every model's automatic build", async () => {
    let finishSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    let settled = false;
    const done = settleModelBuilds(registry({ Fast: async () => {}, Slow: () => slow })).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishSlow();
    await done;
    expect(settled).toBe(true);
  });

  test("a failed build does not throw and the others still finish", async () => {
    let otherFinished = false;
    await settleModelBuilds(
      registry({
        Refused: async () => {
          throw new Error("index not supported");
        },
        Other: async () => {
          otherFinished = true;
        },
      }),
    );
    expect(otherFinished).toBe(true);
  });
});
