/**
 * `@mentra/cloud-core` — Mentra Services. OEM auth runtime, OEM portal backend,
 * miniapp store, REST endpoints.
 *
 * Boot order:
 *   1. Connect Mongo (fail-fast on misconfiguration) and run the startup migrations.
 *   2. On a deployed Core, check the organization configuration (fail-fast: a
 *      missing or malformed `CLOUD_CORE_ORGANIZATION_ID` stops the boot, so the
 *      deploy fails its health check instead of serving 500s on every signed-in path).
 *   3. Build the Hono app with readiness checks wired in.
 *   4. Start Bun.serve.
 *   5. Register SIGTERM/SIGINT handlers for graceful shutdown.
 *
 * When imported (e.g. by integration tests), nothing runs — call
 * `startCore({ port, mongoUrl })` to boot. When executed directly via
 * `bun packages/core/src/index.ts`, the `import.meta.main` block at the
 * bottom drives the boot from env vars.
 *
 * Specs: cloud-v2/docs/issues/001-oem-auth/, 002-oem-portal/, miniapp store work.
 */

import {createLogger} from "@mentra/cloud-shared"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "./connections/mongo.connection"
import {createApp} from "./api/app"
import {runStartupMigrations} from "./migrations/startup.migrations"
import {createCoreStop, serveCore} from "./http-server"
import {startFrameworkRunSummaryBackfill} from "./services/framework-run-summary.service"
import {startRoutineWorkReporting} from "./services/routine-work-notification"
import {warnIfWorkosIdentitiesStaySeparate} from "./services/workspaces/identity-link.service"
import {credentialEnvironmentLabels, isDeployedEnvironment, organizationId} from "./services/workspaces/organization"

const logger = createLogger("core")

export interface StartCoreOptions {
  /** HTTP port. Default: `process.env.PORT ?? 3000`. */
  port?: number
  /** Mongo URL. Default: `process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2"`. */
  mongoUrl?: string
}

export interface CoreHandle {
  port: number
  url: string
  /** Stop the HTTP server and close Mongo. */
  stop(): Promise<void>
}

export async function startCore(opts: StartCoreOptions = {}): Promise<CoreHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3000", 10)
  const mongoUrl = opts.mongoUrl ?? process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2"

  await connectMongo(mongoUrl)
  try {
    await runStartupMigrations()
    checkDeploymentConfiguration()
  } catch (error) {
    // Disconnect best-effort: a secondary disconnect failure must not mask the
    // original boot error, which is what we rethrow.
    await disconnectMongo().catch((disconnectError) => {
      logger.warn({disconnectError}, "failed to disconnect mongo after a boot failure")
    })
    throw error
  }

  warnIfWorkosIdentitiesStaySeparate(logger)

  const app = createApp({readinessChecks: [mongoReadinessCheck]})
  const server = serveCore(app.fetch, port)
  const boundPort = server.port!
  const stopSummaryBackfill = startFrameworkRunSummaryBackfill()
  const stopRoutineWorkReporting = startRoutineWorkReporting()

  logger.info({port: boundPort}, "cloud-v2 core listening")

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    stop: createCoreStop(server, async () => {
      await stopSummaryBackfill()
      await stopRoutineWorkReporting()
      await disconnectMongo()
    }),
  }
}

/**
 * On a deployed Core, read the organization configuration once before serving.
 * Every identity-bearing path needs `organizationId()`, so a missing or malformed
 * `CLOUD_CORE_ORGANIZATION_ID` must stop the boot rather than surface later as a
 * 500 on admin sign-in, the workspace APIs and the internal service API. Local
 * runs keep the `local` default.
 */
function checkDeploymentConfiguration(): void {
  if (!isDeployedEnvironment()) return
  const organization = organizationId()
  const credentialEnvironments = credentialEnvironmentLabels()
  logger.info({organizationId: organization, credentialEnvironments}, "organization configuration checked")
}

if (import.meta.main) {
  const handle = await startCore()
  const shutdown = async (signal: string) => {
    logger.info({signal}, "shutdown requested")
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
