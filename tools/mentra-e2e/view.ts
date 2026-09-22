import {realpath} from "node:fs/promises"
import {join, relative, resolve} from "node:path"

/** Serve one report locally; Bun handles video byte ranges for chapter seeking. */
export async function startReportViewer(directory: string) {
  const root = await realpath(resolve(directory))
  if (!(await Bun.file(join(root, "index.html")).exists())) throw new Error("Run directory has no index.html")
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.hostname !== "127.0.0.1") return new Response("Invalid host", {status: 403})
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Read only", {status: 405})
      const name = url.pathname.slice(1) || "index.html"
      // Do not expose meeting URLs, native logs, credentials or replay sources.
      if (
        !["index.html", "routine.mp4", "chapters.json"].includes(name) &&
        !/^screenshots\/[A-Za-z0-9_.-]+\.(png|jpg|jpeg)$/.test(name) &&
        !/^accessibility\/[A-Za-z0-9_.-]+\.(xml|json)$/.test(name)
      )
        return new Response("Not found", {status: 404})
      const path = await realpath(join(root, name)).catch(() => undefined)
      if (!path || relative(root, path).startsWith("..")) return new Response("Not found", {status: 404})
      return new Response(Bun.file(path), {headers: {"Cache-Control": "no-store"}})
    },
  })
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun tools/mentra-e2e/view.ts RUN_DIRECTORY")
  const server = await startReportViewer(process.argv[2])
  console.log(`Report: http://127.0.0.1:${server.port}/\nKeep this process running while reviewing. Ctrl-C stops it.`)
  process.once("SIGINT", () => server.stop(true))
  process.once("SIGTERM", () => server.stop(true))
}
