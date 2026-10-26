/**
 * Test-only worker entry: reports the identity it resolves, using the same
 * code path as worker.ts (resolveWorkerIdentity over workerData + env), without
 * needing Redis.
 */
import { workerData } from "node:worker_threads";
import { resolveWorkerIdentity } from "./identity";

const identity = resolveWorkerIdentity(workerData, {
  // Static reads, exactly as worker.ts does.
  WORKER_ID: process.env.WORKER_ID,
  POD_ID: process.env.POD_ID,
});
(globalThis as unknown as { postMessage(message: unknown): void }).postMessage(identity);
