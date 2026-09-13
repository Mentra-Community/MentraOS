import {createLogger} from "@mentra/cloud-shared"
import {createApp} from "./api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "./connections/mongo.connection"
import {runStartupMigrations} from "./migrations/startup.migrations"

const logger = createLogger("store")

export interface StartStoreOptions {
  port?: number
  mongoUrl?: string
}
export interface StoreHandle {
  port: number
  url: string
  stop(): Promise<void>
}

export async function startStore(opts: StartStoreOptions = {}): Promise<StoreHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3003", 10)
  const mongoUrl = opts.mongoUrl ?? process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2"
  await connectMongo(mongoUrl)
  try {
    await runStartupMigrations()
  } catch (error) {
    await disconnectMongo().catch((disconnectError) =>
      logger.warn({disconnectError}, "failed to disconnect after migration failure"),
    )
    throw error
  }
  const server = Bun.serve({port, fetch: createApp({readinessChecks: [mongoReadinessCheck]}).fetch})
  const boundPort = server.port!
  logger.info({port: boundPort}, "Mentra Miniapp Store backend listening")
  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    async stop() {
      server.stop()
      await disconnectMongo()
    },
  }
}

if (import.meta.main) {
  const handle = await startStore()
  const shutdown = async (signal: string) => {
    logger.info({signal}, "shutdown requested")
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
