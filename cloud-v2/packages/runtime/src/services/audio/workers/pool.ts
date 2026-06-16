/**
 * @fileoverview Worker pool — spawns N Bun Workers per pod, assigns users
 * by least-loaded, forwards inbound transcripts to the user's WebSocket.
 *
 * Why workers own their stream reads (instead of main thread routing):
 *   - At 200–1000 users/pod target, main-thread per-entry routing becomes
 *     the bottleneck (one event loop dispatching tens of thousands of
 *     entries/sec). Workers reading directly scales linearly with worker
 *     count.
 *   - Worker death stays local: ioredis cleans up when the thread exits;
 *     main thread reassigns the dead worker's users and the new worker
 *     XAUTOCLAIMs any unacked PEL entries.
 *
 * Assignment policy:
 *   - **Least-loaded** by session count (not hash). Each session is roughly
 *     equivalent workload at session-time, and reconnects typically cross
 *     pod boundaries anyway, so hash's "sticky on reconnect" property
 *     doesn't survive the failure case it'd most matter for. Least-loaded
 *     avoids the hash-collision-stacks-two-heavy-users-on-one-worker class
 *     of problems with no real cost.
 *
 * IPC surface (worker side: `./worker.ts`):
 *   - main → worker: `ATTACH_USER`, `DETACH_USER`, `UPDATE_SUBSCRIPTIONS`,
 *     `SET_CODEC`, `SHUTDOWN`
 *   - worker → main: `WORKER_READY`, `TRANSCRIPT_STUB`, `TRANSCRIPT`,
 *     `UDP_LIVENESS_ACK`
 */

import { createLogger } from "@mentra/cloud-shared";
import type {
  AudioCodec,
  SetCodecMessage,
  TranscriptMessage,
  TranscriptStubMessage,
  UdpLivenessAckMessage,
  WorkerInMessage,
  WorkerOutMessage,
} from "./worker";

const logger = createLogger("audio").child({ service: "worker-pool" });

const WORKER_URL = new URL("./worker.ts", import.meta.url);

interface WorkerSlot {
  id: string;
  worker: Worker;
  sessionCount: number;
  ready: boolean;
  /** Users this worker owns; recomputed if it dies and we reassign. */
  ownedUsers: Set<string>;
  /** ATTACH_USER messages queued while waiting for WORKER_READY. */
  pendingAttaches: string[];
  /**
   * Users with a pending reconcile nudge (UPDATE_SUBSCRIPTIONS) queued while
   * waiting for WORKER_READY. A Set, not a list of snapshots: the nudge carries
   * no subs (the worker reads the subscription key), so duplicate nudges
   * collapse to one.
   */
  pendingSubscriptions: Set<string>;
  /** SET_CODEC messages queued while waiting for WORKER_READY. */
  pendingCodecs: Map<string, SetCodecMessage>;
}

interface WorkerPoolState {
  podId: string;
  workers: WorkerSlot[];
  /** mentraUserId → WorkerSlot. So DETACH/release knows which worker holds them. */
  userToWorker: Map<string, WorkerSlot>;
  /**
   * Callback set by session.service: route worker-emitted messages to the
   * user's WS. Receives real transcripts, routing stubs, and control acks.
   */
  transcriptHandler:
    | ((msg: TranscriptStubMessage | TranscriptMessage | UdpLivenessAckMessage) => void)
    | null;
  /** Cleared by stopWorkerPool to suppress respawn during shutdown. */
  shuttingDown: boolean;
}

let pool: WorkerPoolState | null = null;

export interface StartWorkerPoolOptions {
  podId: string;
  /** Number of workers to spawn. Default: 2 if not set (tests can pass 1–4). */
  count?: number;
}

export function startWorkerPool(opts: StartWorkerPoolOptions): void {
  if (pool) {
    logger.warn("startWorkerPool called twice; ignoring");
    return;
  }
  const count = opts.count ?? 2;
  pool = {
    podId: opts.podId,
    workers: [],
    userToWorker: new Map(),
    transcriptHandler: null,
    shuttingDown: false,
  };
  for (let i = 0; i < count; i++) {
    pool.workers.push(spawnWorkerSlot(`w${i}`));
  }
  logger.info({ count }, "worker pool started");
}

export async function stopWorkerPool(): Promise<void> {
  if (!pool) return;
  pool.shuttingDown = true;
  const slots = pool.workers;
  pool = null;
  // Tell each worker to drain Redis + exit, then terminate after a grace
  // period if they don't ack.
  await Promise.all(
    slots.map(async (slot) => {
      try {
        slot.worker.postMessage({ type: "SHUTDOWN" } satisfies WorkerInMessage);
      } catch {
        /* worker may already be gone */
      }
      // Give it 500ms to close Redis cleanly; then terminate.
      await Bun.sleep(500);
      slot.worker.terminate();
    }),
  );
}

/**
 * Register the callback that routes worker → main messages onward to the
 * user's WebSocket. Called once by `session.service` at boot.
 */
export function onTranscript(
  handler: (msg: TranscriptStubMessage | TranscriptMessage | UdpLivenessAckMessage) => void,
): void {
  if (!pool) throw new Error("worker pool not started");
  pool.transcriptHandler = handler;
}

/**
 * Assign a user to the least-loaded worker. Idempotent for the SAME user
 * (returns the existing slot if already assigned — useful for the
 * `already-ours` ownership case where the same user might re-attach
 * during a reconnect race).
 */
export function assignUser(mentraUserId: string): void {
  if (!pool) throw new Error("worker pool not started");
  const existing = pool.userToWorker.get(mentraUserId);
  if (existing) return;
  const slot = pickLeastLoaded(pool);
  slot.sessionCount++;
  slot.ownedUsers.add(mentraUserId);
  pool.userToWorker.set(mentraUserId, slot);
  if (slot.ready) {
    slot.worker.postMessage({
      type: "ATTACH_USER",
      mentraUserId,
    } satisfies WorkerInMessage);
  } else {
    // Worker hasn't finished its Redis-ready bootstrap. Queue the attach;
    // we drain it once WORKER_READY arrives.
    slot.pendingAttaches.push(mentraUserId);
  }
  logger.debug(
    { mentraUserId, workerId: slot.id, sessionCount: slot.sessionCount },
    "user assigned to worker",
  );
}

/**
 * Nudge the worker holding `mentraUserId` to reconcile its subscriptions from
 * the Redis subscription key (the source of truth). Called by the main thread
 * after it seeds the key at `connection.init`. Cross-pod REST writes reach the
 * owning worker through the control stream instead; this IPC path is only for
 * the local same-pod seed. No-op if the user isn't assigned to a worker here.
 *
 * Idempotent: the worker re-reads the key and diffs against its current state,
 * so reissuing the nudge is harmless.
 */
export function reconcileSubscriptions(mentraUserId: string): void {
  if (!pool) return;
  const slot = pool.userToWorker.get(mentraUserId);
  if (!slot) return;
  const msg: WorkerInMessage = {
    type: "UPDATE_SUBSCRIPTIONS",
    mentraUserId,
  };
  if (slot.ready) {
    slot.worker.postMessage(msg);
  } else {
    slot.pendingSubscriptions.add(mentraUserId);
  }
}

/**
 * Set the audio codec for `mentraUserId` on whichever worker holds them.
 * Called once per session from the connection.init handler, before audio
 * flows. No-op if the user isn't assigned to a worker on this pod.
 */
export function setUserCodec(
  mentraUserId: string,
  codec: AudioCodec,
  frameSizeBytes?: SetCodecMessage["frameSizeBytes"],
): void {
  if (!pool) return;
  const slot = pool.userToWorker.get(mentraUserId);
  if (!slot) return;
  const msg: WorkerInMessage = { type: "SET_CODEC", mentraUserId, codec, frameSizeBytes };
  if (slot.ready) {
    slot.worker.postMessage(msg);
  } else {
    slot.pendingCodecs.set(mentraUserId, msg);
  }
}

export function releaseUser(mentraUserId: string): void {
  if (!pool) return;
  const slot = pool.userToWorker.get(mentraUserId);
  if (!slot) return;
  slot.sessionCount = Math.max(0, slot.sessionCount - 1);
  slot.ownedUsers.delete(mentraUserId);
  pool.userToWorker.delete(mentraUserId);
  try {
    slot.worker.postMessage({
      type: "DETACH_USER",
      mentraUserId,
    } satisfies WorkerInMessage);
  } catch {
    /* worker already dead — its replacement won't have this user */
  }
  logger.debug(
    { mentraUserId, workerId: slot.id, sessionCount: slot.sessionCount },
    "user released from worker",
  );
}

export function getPoolStats(): {
  workerCount: number;
  perWorker: Array<{ id: string; sessionCount: number; ready: boolean }>;
} {
  if (!pool) return { workerCount: 0, perWorker: [] };
  return {
    workerCount: pool.workers.length,
    perWorker: pool.workers.map((w) => ({
      id: w.id,
      sessionCount: w.sessionCount,
      ready: w.ready,
    })),
  };
}

// === Internals ===

function pickLeastLoaded(p: WorkerPoolState): WorkerSlot {
  let best = p.workers[0]!;
  for (let i = 1; i < p.workers.length; i++) {
    if (p.workers[i]!.sessionCount < best.sessionCount) best = p.workers[i]!;
  }
  return best;
}

function spawnWorkerSlot(id: string): WorkerSlot {
  const env = {
    ...(process.env as Record<string, string>),
    WORKER_ID: id,
    POD_ID: pool?.podId ?? process.env.POD_ID ?? "pod",
  };
  // Bun.Worker honors options including `env` on a per-worker basis.
  // Type cast keeps lib.dom WebWorker types from complaining about the
  // Bun-specific options object.
  const worker = new Worker(WORKER_URL, {
    type: "module",
    env,
  } as WorkerOptions);

  const slot: WorkerSlot = {
    id,
    worker,
    sessionCount: 0,
    ready: false,
    ownedUsers: new Set(),
    pendingAttaches: [],
    pendingSubscriptions: new Set(),
    pendingCodecs: new Map(),
  };

  worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
    const msg = e.data;
    if (msg.type === "WORKER_READY") {
      slot.ready = true;
      logger.info({ workerId: id, pendingAttaches: slot.pendingAttaches.length }, "worker ready");
      // Drain queued attaches and any subscriptions that arrived before ready.
      for (const userId of slot.pendingAttaches) {
        worker.postMessage({ type: "ATTACH_USER", mentraUserId: userId } satisfies WorkerInMessage);
      }
      slot.pendingAttaches.length = 0;
      for (const msg of slot.pendingCodecs.values()) {
        worker.postMessage(msg);
      }
      slot.pendingCodecs.clear();
      for (const userId of slot.pendingSubscriptions) {
        worker.postMessage({
          type: "UPDATE_SUBSCRIPTIONS",
          mentraUserId: userId,
        } satisfies WorkerInMessage);
      }
      slot.pendingSubscriptions.clear();
      return;
    }
    if (msg.type === "TRANSCRIPT_STUB" || msg.type === "TRANSCRIPT" || msg.type === "UDP_LIVENESS_ACK") {
      pool?.transcriptHandler?.(msg);
      return;
    }
  };

  worker.onerror = (ev: ErrorEvent) => {
    logger.error({ workerId: id, message: ev.message }, "worker error event");
  };

  // Worker death: Bun fires no standard "exit" event — `terminate()` /
  // crash propagates as the worker becoming unable to postMessage. We
  // wrap with a check on next message attempt; for explicit detection,
  // a stub heartbeat would help. For now (stub stage), restart on
  // catastrophic ws.onerror is good enough.
  return slot;
}

/**
 * Test hook — terminate a worker by index (or all) and respawn. Used by
 * the multi-pod failover tests; not for production use.
 */
export function _killWorkerForTest(index: number): void {
  if (!pool) return;
  const slot = pool.workers[index];
  if (!slot) return;
  slot.worker.terminate();
  // Reassign its users to other workers.
  const orphans = [...slot.ownedUsers];
  pool.workers[index] = spawnWorkerSlot(slot.id);
  // The new worker comes up empty; reassign orphans via assignUser
  // (which now picks the least-loaded, naturally including the fresh one).
  for (const userId of orphans) {
    pool.userToWorker.delete(userId);
    assignUser(userId);
  }
}
