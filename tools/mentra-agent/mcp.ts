#!/usr/bin/env bun
/**
 * @fileoverview MCP (Model Context Protocol) face of the mentra-agent harness.
 *
 * Exposes the same control plane as cli.ts as typed MCP tools, so any agent
 * (Claude Code, Codex, etc.) can drive the running MentraOS app natively:
 *
 *   { "mcpServers": { "mentra-agent": {
 *       "command": "bun", "args": ["tools/mentra-agent/mcp.ts"] } } }
 *
 * Stdio transport, newline-delimited JSON-RPC 2.0. Requires the harness
 * server (server.ts) to be running and an app bridge connected; tools return
 * a clear error otherwise. Hand-rolled (no SDK dep) — the surface is three
 * methods: initialize, tools/list, tools/call.
 */

const BASE = process.env.MENTRA_AGENT_URL ?? "http://localhost:8787"

async function rpc(method: string, params?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({method, params}),
  })
  const body = (await res.json()) as {ok: boolean; result?: unknown; error?: string}
  if (!body.ok) throw new Error(body.error ?? `rpc ${method} failed`)
  return body.result
}

// The glasses daemon (tools/mentra-agent/ble) holds the live BLE link to the
// real Even G2 hardware; these tools drive it over its localhost control API.
const GLASSES_BASE = process.env.GLASSES_DAEMON_URL ?? "http://127.0.0.1:8799"
async function glasses(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${GLASSES_BASE}${path}`, {
    method,
    headers: body ? {"content-type": "application/json"} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null)
  if (!res) throw new Error(`glasses daemon unreachable on ${GLASSES_BASE} — start it: tools/mentra-agent/ble/gd.sh start`)
  return res.json()
}

async function speechPcmBase64(phrase: string): Promise<string> {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 16)}`
  const aiff = `/tmp/mentra-mcp-say-${stamp}.aiff`
  const wav = `/tmp/mentra-mcp-say-${stamp}.wav`
  const say = Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase])
  if (say.exitCode !== 0) throw new Error("say failed")
  const conv = Bun.spawnSync(["/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"])
  if (conv.exitCode !== 0) throw new Error("afconvert failed")
  const buf = new Uint8Array(await Bun.file(wav).arrayBuffer())
  const idx = Buffer.from(buf).indexOf("data")
  if (idx < 0) throw new Error("no data chunk in WAV")
  return Buffer.from(buf.subarray(idx + 8)).toString("base64")
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

const TOOLS: ToolDef[] = [
  {
    name: "app_state",
    description:
      "Current MentraOS app state: cloud connection status, audio transport (udp/ws/none), resolved core/runtime endpoints.",
    inputSchema: {type: "object", properties: {}},
    run: () => rpc("getState"),
  },
  {
    name: "app_login",
    description:
      "Sign the app in as the QA test user (credentials from QA_TEST_EMAIL/QA_TEST_PASSWORD env or Doppler cloud-v2/dev). Drives the real Supabase password sign-in.",
    inputSchema: {type: "object", properties: {}},
    run: async () => {
      let email = process.env.QA_TEST_EMAIL
      let password = process.env.QA_TEST_PASSWORD
      if (!email || !password) {
        const proc = Bun.spawn(
          ["doppler", "secrets", "download", "--project", "cloud-v2", "--config", "dev", "--no-file", "--format", "json"],
          {stdout: "pipe", stderr: "pipe"},
        )
        const text = await new Response(proc.stdout).text()
        if ((await proc.exited) === 0) {
          const secrets = JSON.parse(text) as Record<string, string>
          email = email ?? secrets.QA_TEST_EMAIL
          password = password ?? secrets.QA_TEST_PASSWORD
        }
      }
      if (!email || !password) throw new Error("QA creds not found")
      return rpc("login", {email, password})
    },
  },
  {
    name: "app_navigate",
    description: "Navigate the app to an expo-router path, e.g. /miniapps/settings/developer.",
    inputSchema: {type: "object", properties: {path: {type: "string"}}, required: ["path"]},
    run: (a) => rpc("navigate", {path: a.path}),
  },
  {
    name: "app_setting",
    description: "Read or write an app setting. Omit `value` to read.",
    inputSchema: {type: "object", properties: {key: {type: "string"}, value: {}}, required: ["key"]},
    run: (a) => ("value" in a ? rpc("setSetting", {key: a.key, value: a.value}) : rpc("getSetting", {key: a.key})),
  },
  {
    name: "app_cloud_reconnect",
    description: "Tear down and rebuild the Cloud V2 client with freshly-resolved endpoints.",
    inputSchema: {type: "object", properties: {}},
    run: () => rpc("cloudReconnect"),
  },
  {
    name: "app_launch_miniapp",
    description: "Launch a local island miniapp by package name.",
    inputSchema: {type: "object", properties: {packageName: {type: "string"}}, required: ["packageName"]},
    run: (a) => rpc("launchMiniapp", {packageName: a.packageName}),
  },
  {
    name: "app_speak",
    description:
      "End-to-end captions test: subscribe to transcription, synthesize the phrase as audio on the dev machine, inject it into the app's real mic path, and return the transcripts that come back from the cloud. Requires cloud_audio_codec=pcm (set + reconnect first if needed).",
    inputSchema: {
      type: "object",
      properties: {
        phrase: {type: "string"},
        language: {type: "string", description: "bare ISO code, default en"},
        timeoutSeconds: {type: "number"},
      },
      required: ["phrase"],
    },
    run: async (a) => {
      const lang = String(a.language ?? "en")
      await rpc("setSubscriptions", {subs: [{kind: "transcription", language: {mode: "specific", code: lang}}]})
      const eventsBefore = (await (await fetch(`${BASE}/events?since=0`)).json()) as {seq: number}[]
      const baseline = eventsBefore.at(-1)?.seq ?? 0
      const pcmBase64 = await speechPcmBase64(String(a.phrase))
      const injected = await rpc("injectAudio", {pcmBase64})
      const deadline = Date.now() + Number(a.timeoutSeconds ?? 30) * 1000
      const transcripts: unknown[] = []
      let since = baseline
      let sawFinal = false
      while (Date.now() < deadline && !sawFinal) {
        const fresh = (await (
          await fetch(`${BASE}/events?since=${since}&filter=transcript`)
        ).json()) as {seq: number; data: {text?: string; isFinal?: boolean}}[]
        for (const e of fresh) {
          since = e.seq
          transcripts.push(e.data)
          if (e.data.isFinal) sawFinal = true
        }
        if (!sawFinal) await Bun.sleep(500)
      }
      return {injected, transcripts}
    },
  },
  {
    name: "app_events",
    description:
      "Recent app events from the bridge ring buffer (transcript, translation, cloudConnection, cloudStatus). Optional filter by event name and since-sequence.",
    inputSchema: {type: "object", properties: {filter: {type: "string"}, since: {type: "number"}}},
    run: async (a) => {
      const url = new URL(`${BASE}/events`)
      url.searchParams.set("since", String(a.since ?? 0))
      if (a.filter) url.searchParams.set("filter", String(a.filter))
      return (await fetch(url)).json()
    },
  },
  {
    name: "glasses_status",
    description:
      "Status of the live BLE link to the REAL Even G2 glasses (via the glasses daemon, no phone): connected, which arms, audio frame count, last text shown. Requires the daemon: tools/mentra-agent/ble/gd.sh start.",
    inputSchema: {type: "object", properties: {}},
    run: () => glasses("GET", "/status"),
  },
  {
    name: "glasses_connect",
    description:
      "Connect the daemon to the real glasses by factory-serial suffix (e.g. 3248). Glasses must be awake (unfolded) and off the phone (BLE single-central).",
    inputSchema: {
      type: "object",
      properties: {serial: {type: "string"}, waitSeconds: {type: "number"}},
      required: ["serial"],
    },
    run: (a) => glasses("POST", "/connect", {serial: a.serial, waitMs: Number(a.waitSeconds ?? 30) * 1000}),
  },
  {
    name: "glasses_text",
    description: "Display text on the REAL glasses lens over the live BLE link.",
    inputSchema: {type: "object", properties: {text: {type: "string"}}, required: ["text"]},
    run: (a) => glasses("POST", "/text", {text: a.text}),
  },
  {
    name: "glasses_mic",
    description:
      "Enable/disable the real glasses microphone (auto-creates a display page first, which the mic requires). Pair with the captions bridge (ble/cap.sh) for transcripts.",
    inputSchema: {type: "object", properties: {enable: {type: "boolean"}}, required: ["enable"]},
    run: (a) => glasses("POST", "/mic", {enable: !!a.enable}),
  },
  {
    name: "glasses_brightness",
    description: "Set the real glasses display brightness (level 0-255, optional auto mode).",
    inputSchema: {
      type: "object",
      properties: {level: {type: "number"}, auto: {type: "boolean"}},
      required: ["level"],
    },
    run: (a) => glasses("POST", "/brightness", {level: Number(a.level), auto: !!a.auto}),
  },
  {
    name: "glasses_image",
    description:
      "Display an image on the real G2 lens. Pass bmpBase64 (a 4-bit grayscale BMP) to show your own image, or omit it to render a built-in demo test pattern. width/height/x/y position it (G2 only).",
    inputSchema: {
      type: "object",
      properties: {
        bmpBase64: {type: "string"},
        width: {type: "number"},
        height: {type: "number"},
        x: {type: "number"},
        y: {type: "number"},
      },
    },
    run: (a) => glasses("POST", "/image", a),
  },
  {
    name: "glasses_info",
    description: "Query the real glasses for battery %, charging state, and firmware version (works on G1 and G2).",
    inputSchema: {type: "object", properties: {}},
    run: () => glasses("GET", "/info"),
  },
  {
    name: "glasses_imu",
    description:
      "Enable/disable IMU head-orientation reporting on the real G2 (samples appear in glasses_status.imu). G2 only.",
    inputSchema: {type: "object", properties: {enable: {type: "boolean"}, freq: {type: "number"}}, required: ["enable"]},
    run: (a) => glasses("POST", "/imu", {enable: !!a.enable, freq: Number(a.freq ?? 100)}),
  },
  {
    name: "glasses_photo",
    description:
      "Capture a photo on a Mentra Live (camera glasses). Returns the glasses' photo_response (success + any error). Mentra Live only.",
    inputSchema: {type: "object", properties: {size: {type: "string", description: "small|medium|large"}}},
    run: (a) => glasses("POST", "/photo", {size: a.size ?? "medium"}),
  },
]

// --- stdio JSON-RPC plumbing -------------------------------------------------

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\n")
}

function replyError(id: unknown, message: string): void {
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, error: {code: -32000, message}}) + "\n")
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk)
  let nl: number
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg: {id?: unknown; method?: string; params?: {name?: string; arguments?: Record<string, unknown>}}
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: {tools: {}},
        serverInfo: {name: "mentra-agent", version: "1.0.0"},
      })
    } else if (msg.method === "notifications/initialized") {
      /* no response to notifications */
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: TOOLS.map(({name, description, inputSchema}) => ({name, description, inputSchema})),
      })
    } else if (msg.method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === msg.params?.name)
      if (!tool) {
        replyError(msg.id, `unknown tool: ${msg.params?.name}`)
      } else {
        try {
          const result = await tool.run(msg.params?.arguments ?? {})
          reply(msg.id, {content: [{type: "text", text: JSON.stringify(result, null, 2)}]})
        } catch (err) {
          reply(msg.id, {content: [{type: "text", text: `error: ${(err as Error).message}`}], isError: true})
        }
      }
    } else if (msg.id !== undefined) {
      replyError(msg.id, `unknown method: ${msg.method}`)
    }
  }
}
