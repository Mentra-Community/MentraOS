/**
 * `@mentra/cloud-proxy` — Forwarder / reverse proxy. OEM-deployable.
 * Handles REST + WS + UDP relay with per-traffic-type upstream config.
 *
 * Spec + design pending: cloud-v2/docs/issues/004-api-proxy/.
 */

import { createHealthApp, createLogger } from "@mentra/cloud-shared";

const logger = createLogger("proxy");
const PORT = Number.parseInt(process.env.PORT ?? "3002", 10);

const app = createHealthApp({
  packageName: "proxy",
  readinessChecks: [],
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info({ port: server.port }, "cloud-v2 proxy listening (REST relay pending)");
