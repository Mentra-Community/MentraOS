import { Hono } from "hono";
import { streamOptionsSchema } from "@mentra/cloud-protocol/camera";
import { createLogger } from "@mentra/cloud-shared";
import {
  getStreamProvider,
  type StreamProvider,
} from "../services/stream/stream.service";
import { authenticateRuntimeRequest } from "./runtime-auth";

const logger = createLogger("runtime").child({ service: "managed-streams" });
const DEFAULT_STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

interface OwnedStream {
  ownerId: string;
  expiresAt: number;
  cleanup: "reclaim" | "stop";
}

export interface ManagedStreamsHandle {
  api: Hono;
  stop(): Promise<void>;
}

export function createManagedStreamsApi(
  options: {
    provider?: StreamProvider;
    streamTtlMs?: number;
    sweepIntervalMs?: number;
  } = {},
): ManagedStreamsHandle {
  const provider = options.provider ?? getStreamProvider();
  const streamTtlMs =
    options.streamTtlMs ??
    Number(process.env.MANAGED_STREAM_TTL_MS ?? DEFAULT_STREAM_TTL_MS);
  const sweepIntervalMs =
    options.sweepIntervalMs ??
    Number(
      process.env.MANAGED_STREAM_SWEEP_INTERVAL_MS ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
  const owned = new Map<string, OwnedStream>();
  const api = new Hono();

  function requireOwned(streamId: string, ownerId: string): Response | null {
    const entry = owned.get(streamId);
    if (!entry || entry.ownerId !== ownerId) {
      return Response.json({ error: "stream not found" }, { status: 404 });
    }
    entry.expiresAt = Date.now() + streamTtlMs;
    return null;
  }

  api.post("/stream", async (c) => {
    const auth = await authenticateRuntimeRequest(c);
    if ("error" in auth) return auth.error;
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty options use the protocol defaults.
    }
    const parsed = streamOptionsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: "invalid stream options", issues: parsed.error.issues },
        400,
      );
    }
    const result = await provider.provision(
      auth.identity.mentraUserId,
      parsed.data,
    );
    owned.set(result.streamId, {
      ownerId: auth.identity.mentraUserId,
      expiresAt: Date.now() + streamTtlMs,
      cleanup: "reclaim",
    });
    return c.json(result, 200);
  });

  api.get("/stream/:id", async (c) => {
    const auth = await authenticateRuntimeRequest(c);
    if ("error" in auth) return auth.error;
    const streamId = c.req.param("id");
    const denied = requireOwned(streamId, auth.identity.mentraUserId);
    if (denied) return denied;
    return c.json(await provider.status(streamId), 200);
  });

  api.delete("/stream/:id", async (c) => {
    const auth = await authenticateRuntimeRequest(c);
    if ("error" in auth) return auth.error;
    const streamId = c.req.param("id");
    const denied = requireOwned(streamId, auth.identity.mentraUserId);
    if (denied) return denied;
    const result = await provider.stop(streamId);
    if (result.input === "retained") {
      owned.set(streamId, {
        ownerId: auth.identity.mentraUserId,
        expiresAt: Date.now() + sweepIntervalMs,
        cleanup: "stop",
      });
    } else {
      owned.delete(streamId);
    }
    return c.json({ streamId, status: "stopped" }, 200);
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sweep = async () => {
    if (stopped) return;
    const now = Date.now();
    for (const [streamId, entry] of owned) {
      if (entry.expiresAt > now) continue;
      try {
        const result =
          entry.cleanup === "reclaim" && provider.reclaim
            ? await provider.reclaim(streamId)
            : await provider.stop(streamId);
        if (result.input === "retained") {
          entry.expiresAt = Date.now() + sweepIntervalMs;
        } else {
          owned.delete(streamId);
        }
      } catch (err) {
        logger.warn({ err, streamId }, "expired managed stream cleanup failed");
      }
    }
    timer = setTimeout(() => void sweep(), sweepIntervalMs);
  };

  // Re-seed abandoned inputs after a process restart. The dedicated customer
  // stream account is the boundary; only Mentra-tagged inputs are returned by
  // the Cloudflare provider's discovery implementation.
  void provider
    .discover?.()
    .then((result) => {
      for (const input of result.inputs) {
        // Discovery runs concurrently with request handling. Never replace an
        // ownership claim made by a stream created while discovery was in
        // flight; only previously unknown inputs are restart orphans.
        if (!owned.has(input.streamId)) {
          owned.set(input.streamId, {
            ownerId: "__orphaned__",
            expiresAt: input.createdAt + streamTtlMs,
            cleanup: "reclaim",
          });
        }
      }
      if (result.truncated)
        logger.warn("managed stream discovery was truncated");
    })
    .catch((err) => logger.warn({ err }, "managed stream discovery failed"));
  timer = setTimeout(() => void sweep(), sweepIntervalMs);

  return {
    api,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.allSettled(
        [...owned.keys()].map((streamId) => provider.stop(streamId)),
      );
      owned.clear();
    },
  };
}
