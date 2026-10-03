/**
 * Host-side reload hook for the stream preview Maestro flow.
 *
 * A bundled miniapp has no reload control, but a debug build of the Mentra App makes its WebViews
 * inspectable (`webviewDebuggingEnabled={__DEV__}`). On Android that exposes a DevTools socket per
 * process, so this reloads the Mentra Call page with `Page.reload`, the same thing a pull-to-refresh
 * would do: the WebView stays, the document is new. Maestro calls `POST /reload` from
 * `stream-preview-reload.js`.
 *
 * Env: MAESTRO_APP_ID (default com.mentra.mentra), ANDROID_SERIAL, RELOAD_HOOK_PORT (8791),
 * DEVTOOLS_PORT (9223), PREVIEW_PAGE_MATCH (matched against page URL and title; default
 * "com.mentra.call" or the title "Mentra Call").
 */

interface DevtoolsPage {
  type: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
}

const appId = process.env.MAESTRO_APP_ID || "com.mentra.mentra"
const serial = process.env.ANDROID_SERIAL
const hookPort = Number(process.env.RELOAD_HOOK_PORT || 8791)
const devtoolsPort = Number(process.env.DEVTOOLS_PORT || 9223)
const pageMatch = process.env.PREVIEW_PAGE_MATCH

function adb(args: string[]): string {
  const result = Bun.spawnSync(["adb", ...(serial ? ["-s", serial] : []), ...args])
  if (result.exitCode !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

function matches(page: DevtoolsPage): boolean {
  if (page.type !== "page" || !page.webSocketDebuggerUrl) return false
  if (pageMatch) return page.url.includes(pageMatch) || page.title.includes(pageMatch)
  return page.url.includes("com.mentra.call") || page.title === "Mentra Call"
}

async function findPage(): Promise<{page: DevtoolsPage; pages: DevtoolsPage[]}> {
  const pid = adb(["shell", "pidof", appId]).trim().split(/\s+/)[0]
  if (!pid) throw new Error(`${appId} is not running`)
  adb(["forward", `tcp:${devtoolsPort}`, `localabstract:webview_devtools_remote_${pid}`])
  const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
  if (!response.ok) throw new Error(`DevTools list answered ${response.status}; is this a debug build?`)
  const pages = (await response.json()) as DevtoolsPage[]
  const page = pages.find(matches)
  if (!page) {
    const seen = pages.map((entry) => `${entry.type} ${entry.title} ${entry.url}`).join("; ")
    throw new Error(`no Mentra Call page among DevTools targets (set PREVIEW_PAGE_MATCH): ${seen}`)
  }
  return {page, pages}
}

async function reload(page: DevtoolsPage): Promise<void> {
  const socket = new WebSocket(page.webSocketDebuggerUrl!)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Page.reload timed out")), 10_000)
    socket.addEventListener("open", () => socket.send(JSON.stringify({id: 1, method: "Page.reload", params: {}})))
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {id?: number; error?: {message: string}}
      if (message.id !== 1) return
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message))
      else resolve()
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("DevTools socket error"))
    })
  }).finally(() => socket.close())
}

let reloads = 0

Bun.serve({
  hostname: "127.0.0.1",
  port: hookPort,
  async fetch(request) {
    const {pathname} = new URL(request.url)
    if (pathname === "/health") return Response.json({ok: true})
    if (pathname !== "/reload" || request.method !== "POST") return new Response("not found", {status: 404})
    try {
      const {page} = await findPage()
      await reload(page)
      reloads += 1
      console.log(`[stream-preview-reload-hook] reload #${reloads}: ${page.title} ${page.url}`)
      return Response.json({reloads, title: page.title})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[stream-preview-reload-hook] ${message}`)
      return new Response(message, {status: 500})
    }
  },
})

console.log(`[stream-preview-reload-hook] listening on http://127.0.0.1:${hookPort}`)
