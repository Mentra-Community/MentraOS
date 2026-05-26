/**
 * `@mentra/cloud-audio` — Audio Stack. UDP ingress, workers, Redis-routed
 * ownership, transcription + translation providers.
 *
 * Spec + design: cloud-v2/docs/issues/003-audio/.
 */

import { createHealthApp, createLogger } from "@mentra/cloud-shared";

const logger = createLogger("audio");
const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);

const app = createHealthApp({
  packageName: "audio",
  // Readiness checks are added as dependencies come online:
  // - Redis connection (lands with OS-1503 — Redis Streams audio bus)
  // - At least one worker alive (lands with OS-1505 — worker pool)
  readinessChecks: [],
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info({ port: server.port }, "cloud-v2 audio listening (HTTP only; UDP + WS pending)");
