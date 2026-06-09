/**
 * @fileoverview mentra-agent harness server.
 *
 * The hub between agents/CLI and the running MentraOS app. The app's dev-only
 * agent bridge (mobile/src/dev/agentBridge.ts) dials OUT to this server over
 * WebSocket (`/bridge`); agents and the CLI drive it over a local HTTP control
 * plane. Nothing on the device ever listens for connections.
 *
 *   app (dev build) --ws--> :8787/bridge --+
 *                                          |   POST /rpc {method, params}
 *   mentra-agent CLI / any agent --http--> +   GET  /devices
 *                                          |   GET  /events?since=N (+ ?follow=sse)
 *
 * Events from the app (transcripts, cloud status, connection transitions) land
 * in a ring buffer queryable over HTTP — replacing logcat-grepping and
 * screenshots as the way a harness observes app behavior.
 *
 * Run: bun tools/mentra-agent/server.ts   (or: bun run agent:serve)
 */

type BridgeSocket = Bun.ServerWebSocket<{deviceId: string}>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeEvent {
  seq: number
  receivedAt: string
  deviceId: string
  event: string
  data: unknown
}

const PORT = Number(process.env.MENTRA_AGENT_PORT ?? 8787)
const RPC_TIMEOUT_MS = 120_000 // injectAudio streams near real time; long utterances take a while
const EVENT_RING_MAX = 5_000

const sockets = new Map<string, BridgeSocket>()
const deviceInfo = new Map<string, Record<string, unknown>>()
const pending = new Map<number, PendingCall>()
const events: BridgeEvent[] = []
let nextRpcId = 1
let nextEventSeq = 1
let nextDeviceId = 1

function pushEvent(deviceId: string, event: string, data: unknown): void {
  events.push({seq: nextEventSeq++, receivedAt: new Date().toISOString(), deviceId, event, data})
  if (events.length > EVENT_RING_MAX) events.splice(0, events.length - EVENT_RING_MAX)
  if (process.env.MENTRA_AGENT_QUIET !== "1") {
    console.log(`[event] ${deviceId} ${event} ${JSON.stringify(data)}`)
  }
}

function callDevice(deviceId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
  const ws = sockets.get(deviceId)
  if (!ws) return Promise.reject(new Error(`no connected device: ${deviceId}`))
  const id = nextRpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`rpc timeout: ${method}`))
    }, timeoutMs ?? RPC_TIMEOUT_MS)
    pending.set(id, {resolve, reject, timer})
    ws.send(JSON.stringify({id, method, params}))
  })
}

function pickDevice(requested?: string | null): string | undefined {
  if (requested) return sockets.has(requested) ? requested : undefined
  const ids = [...sockets.keys()]
  return ids[0]
}

const server = Bun.serve<{deviceId: string}>({
  port: PORT,
  hostname: "0.0.0.0", // emulator reaches us via 10.0.2.2; LAN phones via the dev box IP

  fetch(req, srv) {
    const url = new URL(req.url)

    if (url.pathname === "/bridge") {
      const deviceId = `dev${nextDeviceId++}`
      if (srv.upgrade(req, {data: {deviceId}})) return undefined
      return new Response("websocket upgrade required", {status: 426})
    }

    if (url.pathname === "/devices") {
      const list = [...sockets.keys()].map((id) => ({id, ...deviceInfo.get(id)}))
      return Response.json(list)
    }

    if (url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") ?? 0)
      const filter = url.searchParams.get("filter")
      const matched = events.filter((e) => e.seq > since && (!filter || e.event === filter))
      return Response.json(matched)
    }

    if (url.pathname === "/rpc" && req.method === "POST") {
      return (async () => {
        const body = (await req.json()) as {device?: string; method: string; params?: unknown; timeoutMs?: number}
        const deviceId = pickDevice(body.device)
        if (!deviceId) return Response.json({ok: false, error: "no device connected"}, {status: 503})
        try {
          const result = await callDevice(deviceId, body.method, body.params, body.timeoutMs)
          return Response.json({ok: true, device: deviceId, result})
        } catch (err) {
          return Response.json({ok: false, device: deviceId, error: (err as Error).message}, {status: 500})
        }
      })()
    }

    if (url.pathname === "/healthz") return new Response("ok")
    return new Response("not found", {status: 404})
  },

  websocket: {
    // Reap half-open bridge sockets: a device-side network drop can leave the
    // socket ESTABLISHED here forever. The app heartbeats every 5s; 16s of
    // silence means the socket is dead — closing it frees the device slot so
    // the app's reconnect (over adb-reverse localhost) can take over.
    idleTimeout: 16,
    open(ws) {
      sockets.set(ws.data.deviceId, ws)
      console.log(`[bridge] ${ws.data.deviceId} connected (${sockets.size} total)`)
    },
    message(ws, raw) {
      let msg: {id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown}
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (typeof msg.id === "number") {
        const call = pending.get(msg.id)
        if (!call) return
        pending.delete(msg.id)
        clearTimeout(call.timer)
        if (msg.ok) call.resolve(msg.result)
        else call.reject(new Error(msg.error ?? "rpc failed"))
        return
      }
      if (typeof msg.event === "string") {
        if (msg.event === "hb") return // liveness only; Bun's idleTimeout sees the traffic
        if (msg.event === "hello") deviceInfo.set(ws.data.deviceId, (msg.data as Record<string, unknown>) ?? {})
        pushEvent(ws.data.deviceId, msg.event, msg.data)
      }
    },
    close(ws) {
      sockets.delete(ws.data.deviceId)
      deviceInfo.delete(ws.data.deviceId)
      console.log(`[bridge] ${ws.data.deviceId} disconnected`)
    },
  },
})

console.log(`mentra-agent harness listening on http://localhost:${server.port}`)
console.log(`  app bridge:  ws://<this-host>:${server.port}/bridge (dev builds dial in automatically)`)
console.log(`  control:     POST /rpc {method, params} | GET /devices | GET /events?since=N&filter=transcript`)
