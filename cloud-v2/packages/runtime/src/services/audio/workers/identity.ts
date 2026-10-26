/**
 * @fileoverview Audio worker identity (worker id, pod id, Redis consumer name).
 *
 * The pool hands identity to each worker thread through `workerData`, not the
 * `env` option of `new Worker`. Bun's `env` option is unreliable for this:
 * `process.env` inside a worker keeps the parent's value for any key the parent
 * already has, so a pod-level `POD_ID` (or a stray `WORKER_ID`) silently wins
 * over the value the pool passed. `workerData` is structured-cloned verbatim.
 *
 * The identity feeds the Redis consumer name (`<podId>:<workerId>`) used for
 * XREADGROUP / XAUTOCLAIM, so each worker must resolve a distinct one.
 */

export interface WorkerBootData {
  workerId: string;
  podId: string;
}

export interface WorkerIdentity extends WorkerBootData {
  /** Redis consumer-group consumer name: `<podId>:<workerId>`. */
  consumerName: string;
}

const DEFAULT_WORKER_ID = "worker";
const DEFAULT_POD_ID = "pod";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve identity from `workerData` first (set by the pool), then from the
 * environment (a worker started outside the pool, or on the main thread where
 * `workerData` is null), then from defaults.
 */
export function resolveWorkerIdentity(
  data: unknown,
  env: Record<string, string | undefined>,
): WorkerIdentity {
  const boot = (data && typeof data === "object" ? data : {}) as Partial<WorkerBootData>;
  const workerId = nonEmptyString(boot.workerId) ?? nonEmptyString(env.WORKER_ID) ?? DEFAULT_WORKER_ID;
  const podId = nonEmptyString(boot.podId) ?? nonEmptyString(env.POD_ID) ?? DEFAULT_POD_ID;
  return { workerId, podId, consumerName: `${podId}:${workerId}` };
}
