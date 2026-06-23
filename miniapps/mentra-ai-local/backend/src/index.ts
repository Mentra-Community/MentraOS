/**
 * Mentra AI (local) backend.
 *
 * Holds the AI secrets (Gemini + Jina) so they never ship inside the miniapp
 * bundle. The miniapp background calls /api/classify, /api/agent, /api/search
 * with a package-scoped Bearer token; this service verifies the token and runs
 * the AI calls server-side.
 *
 * Boot order mirrors the cloud-v2 services and the merge backend:
 *   1. Build the Hono app from api/app.ts.
 *   2. Start Bun.serve.
 *   3. Register SIGTERM/SIGINT handlers for shutdown.
 */

import {createApp} from "./api/app"

export interface StartMentraAiBackendOptions {
  port?: number
}

export interface MentraAiBackendHandle {
  port: number
  url: string
  stop(): Promise<void>
}

export async function startMentraAiBackend(
  opts: StartMentraAiBackendOptions = {},
): Promise<MentraAiBackendHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3131", 10)
  const app = createApp()
  const server = Bun.serve({port, fetch: app.fetch})
  const boundPort = server.port!

  console.log(`Mentra AI backend listening on http://localhost:${boundPort}`)

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    async stop() {
      server.stop()
    },
  }
}

if (import.meta.main) {
  const handle = await startMentraAiBackend()
  const shutdown = async (signal: string) => {
    console.log(`Mentra AI backend shutdown requested: ${signal}`)
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
