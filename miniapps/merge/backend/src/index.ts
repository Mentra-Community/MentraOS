/**
 * Local Merge backend.
 *
 * Boot order mirrors the cloud-v2 services:
 *   1. Build the Hono app from api/app.ts.
 *   2. Start Bun.serve.
 *   3. Register SIGTERM/SIGINT handlers for shutdown.
 */

import {createApp} from "./api/app"

export interface StartMergeBackendOptions {
  port?: number
}

export interface MergeBackendHandle {
  port: number
  url: string
  stop(): Promise<void>
}

export async function startMergeBackend(opts: StartMergeBackendOptions = {}): Promise<MergeBackendHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3130", 10)
  const app = createApp()
  const server = Bun.serve({port, fetch: app.fetch})
  const boundPort = server.port!

  console.log(`Local Merge backend listening on http://localhost:${boundPort}`)

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    async stop() {
      server.stop()
    },
  }
}

if (import.meta.main) {
  const handle = await startMergeBackend()
  const shutdown = async (signal: string) => {
    console.log(`Local Merge backend shutdown requested: ${signal}`)
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
