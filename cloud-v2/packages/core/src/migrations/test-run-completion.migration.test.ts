import { expect, spyOn, test } from "bun:test";
import { TestRunModel } from "../models/test-run.model";
import { backfillTestRunCompletionDates } from "./test-run-completion.migration";

test("completion migration succeeds with Cosmos MongoDB update-command restrictions", async () => {
  const update = spyOn(TestRunModel.collection, "updateMany").mockImplementation(async (_filter, _pipeline, options) => {
    // Cosmos accepts aggregation updates, but aborts Core startup on a write hint.
    if (options?.hint) throw Object.assign(new Error("Unrecognized field: 'hint'"), { code: 9 });
    expect(options?.maxTimeMS).toBe(120_000);
    expect(options?.writeConcern).toEqual({ w: "majority" });
    return { acknowledged: true, matchedCount: 2, modifiedCount: 2, upsertedCount: 0, upsertedId: null };
  });
  const find = spyOn(TestRunModel.collection, "findOne").mockResolvedValue(null);
  try {
    expect(await backfillTestRunCompletionDates()).toEqual({ matchedCount: 2, modifiedCount: 2, complete: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  } finally {
    update.mockRestore();
    find.mockRestore();
  }
});
