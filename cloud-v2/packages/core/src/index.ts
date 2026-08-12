/**
 * `@mentra/cloud-core` — Mentra Services. OEM auth runtime, OEM portal backend,
 * miniapp store, REST endpoints.
 *
 * Boot order:
 *   1. Connect Mongo (fail-fast on misconfiguration).
 *   2. Build the Hono app with readiness checks wired in.
 *   3. Start Bun.serve.
 *   4. Register SIGTERM/SIGINT handlers for graceful shutdown.
 *
 * When imported (e.g. by integration tests), nothing runs — call
 * `startCore({ port, mongoUrl })` to boot. When executed directly via
 * `bun packages/core/src/index.ts`, the `import.meta.main` block at the
 * bottom drives the boot from env vars.
 *
 * Specs: cloud-v2/docs/issues/001-oem-auth/, 002-oem-portal/, miniapp store work.
 */

import { createLogger } from "@mentra/cloud-shared";
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "./connections/mongo.connection";
import { createApp } from "./api/app";
import { runStartupMigrations } from "./migrations/startup.migrations";
import {
  startSupportTelemetryWorker,
  stopSupportTelemetryWorker,
} from "./services/support-telemetry.service";

const logger = createLogger("core");

export interface StartCoreOptions {
  /** HTTP port. Default: `process.env.PORT ?? 3000`. */
  port?: number;
  /** Mongo URL. Default: `process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2"`. */
  mongoUrl?: string;
}

export interface CoreHandle {
  port: number;
  url: string;
  /** Stop the HTTP server and close Mongo. */
  stop(): Promise<void>;
}

export async function startCore(opts: StartCoreOptions = {}): Promise<CoreHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3000", 10);
  const mongoUrl =
    opts.mongoUrl ??
    process.env.MONGO_URL ??
    "mongodb://127.0.0.1:27017/mentra-cloud-v2";

  await connectMongo(mongoUrl);
  try {
    await runStartupMigrations();
  } catch (error) {
    // Disconnect best-effort: a secondary disconnect failure must not mask the
    // original migration error, which is what we rethrow.
    await disconnectMongo().catch(disconnectError => {
      logger.warn({ disconnectError }, "failed to disconnect mongo after migration failure");
    });
    throw error;
  }

  const app = createApp({ readinessChecks: [mongoReadinessCheck] });
  const server = Bun.serve({ port, fetch: app.fetch });
  const boundPort = server.port!;

  logger.info({ port: boundPort }, "cloud-v2 core listening");
  startSupportTelemetryWorker();

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    async stop() {
      server.stop();
      stopSupportTelemetryWorker();
      await disconnectMongo();
    },
  };
}

if (import.meta.main) {
  const handle = await startCore();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown requested");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
