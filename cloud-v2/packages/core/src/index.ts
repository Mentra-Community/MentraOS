/**
 * `@mentra/cloud-core` — Mentra Services. OEM auth runtime, OEM portal backend,
 * miniapp store, REST endpoints.
 *
 * Specs: cloud-v2/docs/issues/001-oem-auth/, 002-oem-portal/, miniapp store work.
 */

import { createHealthApp, createLogger } from "@mentra/cloud-shared";

const logger = createLogger("core");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = createHealthApp({
  packageName: "core",
  // Readiness checks are added as dependencies come online:
  // - Mongo connection (lands with the OEM auth data model, OS-1496)
  readinessChecks: [],
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info({ port: server.port }, "cloud-v2 core listening");
