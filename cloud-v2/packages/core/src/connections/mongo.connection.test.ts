import { describe, expect, test } from "bun:test";
import { buildModelCollections, type ModelRegistry } from "./mongo.connection";

type Steps = { options?: Record<string, unknown>; collection?: () => Promise<unknown>; indexes?: () => Promise<unknown> };

function registry(models: Record<string, Steps>, log: string[]): ModelRegistry {
  return {
    modelNames: () => Object.keys(models),
    model: (name) => ({
      schema: { get: (option: string) => models[name]!.options?.[option] },
      createCollection: async () => {
        log.push(`${name} collection`);
        await models[name]!.collection?.();
      },
      createIndexes: async () => {
        log.push(`${name} indexes start`);
        await models[name]!.indexes?.();
        log.push(`${name} indexes end`);
      },
    }),
  };
}

describe("buildModelCollections", () => {
  test("builds one model's collection and indexes at a time", async () => {
    const log: string[] = [];
    const slow = () => new Promise((resolve) => setTimeout(resolve, 10));
    await buildModelCollections(registry({ First: { indexes: slow }, Second: {} }, log));
    expect(log).toEqual([
      "First collection",
      "First indexes start",
      "First indexes end",
      "Second collection",
      "Second indexes start",
      "Second indexes end",
    ]);
  });

  test("leaves alone what a schema turns off", async () => {
    const log: string[] = [];
    await buildModelCollections(
      registry({ ReadOnly: { options: { autoCreate: false, autoIndex: false } }, Indexed: { options: { autoCreate: false } } }, log),
    );
    expect(log).toEqual(["Indexed indexes start", "Indexed indexes end"]);
  });

  test("a failed build does not throw and the others still build", async () => {
    const log: string[] = [];
    await buildModelCollections(
      registry(
        {
          Refused: {
            indexes: async () => {
              throw new Error("index not supported");
            },
          },
          Other: {},
        },
        log,
      ),
    );
    expect(log).toContain("Other indexes end");
  });
});
