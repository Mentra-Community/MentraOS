import mongoose from "mongoose";
import { TEST_RUN_COMPLETION_INDEX, TestRunModel } from "../models/test-run.model";

/** Idempotent server projection only; never writes payload, digest, outcomes or upload receipts. */
export async function backfillTestRunCompletionDates() {
  const missing = { completionProjectionVersion: { $ne: 1 } };
  // Cosmos MongoDB 4.2 accepts the pipeline but rejects hints on update commands.
  // Keep index hints on reads only so this migration also runs in private clouds.
  const result = await TestRunModel.collection.updateMany(missing, [{ $set: { completionProjectionVersion: 1, completedAt: {
    $cond: [{ $eq: [{ $type: "$payload.finishedAt" }, "string"] },
      { $convert: { input: "$payload.finishedAt", to: "date", onError: null, onNull: null } }, null],
  } } }], { maxTimeMS: 120_000, writeConcern: { w: "majority" } });
  const remaining = await TestRunModel.collection.findOne(missing,
    { projection: { _id: 1 }, hint: TEST_RUN_COMPLETION_INDEX, maxTimeMS: 5_000 });
  if (remaining) throw new Error("Test-run completion migration is incomplete; retry after older Core writers retire");
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, complete: true };
}

// Explicit retry for a rolling-deployment old-writer gap. Uses the existing deployment
// MONGO_URL; prints counts only. It does not run on dashboard reads.
if (import.meta.main) {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required for the completion-date migration");
  await mongoose.connect(process.env.MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    await TestRunModel.collection.createIndex({ completionProjectionVersion: 1, completedAt: -1, runId: -1 }, { name: TEST_RUN_COMPLETION_INDEX });
    console.log(JSON.stringify({ migration: "test-run-completed-at", ...await backfillTestRunCompletionDates() }));
  } finally { await mongoose.disconnect(); }
}
