/**
 * glasses-captions — real Even G2 mic -> cloud captions, no phone.
 *
 * Pulls live LC3 audio frames from the BLE daemon (tools/mentra-agent/ble,
 * audio WebSocket) and feeds them into the REAL @mentra/cloud-client/node, which
 * does the connection.init handshake, the encrypted-UDP audio path, the
 * transcription subscription, and transcript decode. So this is the actual
 * production client — we just swap the phone's mic for the glasses' over BLE.
 *
 * Run (QA creds come from Doppler, like the cloud-client e2e test):
 *   doppler run --project cloud-v2 --config dev -- \
 *     bun cloud-v2/scripts/glasses-captions.ts
 *
 * Prereq: the BLE daemon is up and connected to the glasses:
 *   tools/mentra-agent/ble/gd.sh start
 *   bun tools/mentra-agent/ble/glasses.mjs connect 3248
 *
 * Env (all optional, sane defaults):
 *   CORE_URL, RUNTIME_URL   default to AWS us-west-2 dev
 *   DAEMON_PORT             default 8799 (audio ws = DAEMON_PORT+1)
 *   QA_TEST_EMAIL/PASSWORD  from Doppler
 *   EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY  read from mobile/.env if unset
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { CloudClient } from "../packages/cloud-client/node"

// Verbose logger so we can see the WS url + any transport/auth error from inside
// the client while debugging the cloud connection.
const dbgLogger = {
  debug: (m: string, meta?: object) => console.log(`[cc.debug] ${m}`, meta ?? ""),
  info: (m: string, meta?: object) => console.log(`[cc.info] ${m}`, meta ?? ""),
  warn: (m: string, meta?: object) => console.log(`[cc.warn] ${m}`, meta ?? ""),
  error: (m: string, meta?: object) => console.log(`[cc.error] ${m}`, meta ?? ""),
}

const HERE = dirname(fileURLToPath(import.meta.url))

// --- config ---------------------------------------------------------------
function fromMobileEnv(key: string): string | undefined {
  try {
    const env = readFileSync(join(HERE, "../../mobile/.env"), "utf8")
    const m = env.match(new RegExp(`^${key}=(.+)$`, "m"))
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || fromMobileEnv("EXPO_PUBLIC_SUPABASE_URL") || "https://auth.mentra.glass"
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || fromMobileEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY")
const EMAIL = process.env.QA_TEST_EMAIL
const PASSWORD = process.env.QA_TEST_PASSWORD
const CORE_URL = process.env.CORE_URL || "https://core.us-west-2.dev.mentraglass.com"
const RUNTIME_URL = process.env.RUNTIME_URL || "https://runtime.us-west-2.dev.mentraglass.com"
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 8799)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const AUDIO_WS = `ws://127.0.0.1:${DAEMON_PORT + 1}`
const LANG = process.env.LANG_CODE || "en"
const TARGET = (process.env.TRANSLATE_TO || "").trim() // e.g. "es" -> show live translation on the lens

if (!SUPABASE_ANON_KEY) throw new Error("no SUPABASE_ANON_KEY (set EXPO_PUBLIC_SUPABASE_ANON_KEY or mobile/.env)")
if (!EMAIL || !PASSWORD) throw new Error("no QA creds — run via: doppler run --project cloud-v2 --config dev -- bun ...")

// --- supabase password login -> access token ------------------------------
let cachedToken: { token: string; at: number } | null = null
async function getToken(): Promise<{ token: string; type: "supabase" }> {
  if (cachedToken && Date.now() - cachedToken.at < 45 * 60_000) return { token: cachedToken.token, type: "supabase" }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const body = (await res.json()) as { access_token?: string; error_description?: string }
  if (!res.ok || !body.access_token) throw new Error(`supabase login failed: ${res.status} ${body.error_description || ""}`)
  cachedToken = { token: body.access_token, at: Date.now() }
  console.log("[captions] logged in as", EMAIL)
  return { token: body.access_token, type: "supabase" }
}

// --- main -----------------------------------------------------------------
async function main() {
  await getToken() // fail fast if creds are wrong

  const client = new CloudClient({
    endpoints: { core: CORE_URL, runtime: RUNTIME_URL },
    audio: { codec: "lc3", sampleRate: 16000, frameSizeBytes: 40 },
    auth: { getSubjectToken: getToken },
    logger: dbgLogger,
  })

  // Mirror captions onto the glasses lens (throttled so we don't flood the BLE
  // link with every interim token). Always push finals; cap interims to ~3/sec.
  let lastMirror = 0
  async function mirror(text: string, isFinal: boolean) {
    const now = Date.now()
    if (!isFinal && now - lastMirror < 350) return
    lastMirror = now
    const shown = text.length > 140 ? text.slice(-140) : text
    try {
      await fetch(`${DAEMON}/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: shown || " " }),
      })
    } catch {}
  }

  let finals = 0
  // In translation mode the lens shows the translated text; otherwise the
  // transcript. We still log transcripts in both modes for visibility.
  client.runtime.onTranscript((d: any) => {
    const tag = d.isFinal ? "FINAL" : "  …  "
    console.log(`[${tag}] ${d.text}`)
    if (d.isFinal) finals++
    if (!TARGET) void mirror(d.text, d.isFinal)
  })
  if (TARGET) {
    client.runtime.onTranslation((d: any) => {
      console.log(`[${d.isFinal ? "ES   " : " es… "}] ${d.text}   (${d.originalText ?? ""})`)
      void mirror(d.text, d.isFinal)
    })
  }

  console.log(`[captions] connecting to cloud ${CORE_URL} ...`)
  // The first AWS handshake occasionally drops with 1002 (cold edge); retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.runtime.connect()
      break
    } catch (e: any) {
      if (attempt >= 10) throw e
      console.log(`[captions] connect attempt ${attempt} failed (${e?.message || e}); retrying...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const subs: any[] = [{ kind: "transcription", language: { mode: "specific", code: LANG } }]
  if (TARGET) subs.push({ kind: "translation", source: { mode: "specific", code: LANG }, target: TARGET })
  await client.runtime.setSubscriptions(subs)
  console.log(`[captions] subscribed: transcription(${LANG})${TARGET ? ` + translation(${LANG}->${TARGET})` : ""}. cloud is ready.`)

  // The glasses mic only streams when a display page exists (G2 re-creates the
  // page before enabling the mic). Create one first — which doubles as the
  // surface we mirror captions onto.
  await fetch(`${DAEMON}/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Listening…" }),
  }).catch(() => null)
  await new Promise((r) => setTimeout(r, 400))

  // tell the daemon to turn the glasses mic on
  const micRes = await fetch(`${DAEMON}/mic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enable: true }),
  }).then((r) => r.json()).catch(() => null)
  console.log("[captions] glasses mic:", micRes)

  // pull LC3 frames from the daemon and feed the cloud
  let frames = 0
  const ws = new WebSocket(AUDIO_WS)
  ws.binaryType = "arraybuffer"
  ws.onopen = () => console.log(`[captions] audio link to daemon open (${AUDIO_WS}). SPEAK NOW.`)
  ws.onmessage = (ev: MessageEvent) => {
    const frame = new Uint8Array(ev.data as ArrayBuffer)
    client.runtime.sendAudioFrame(frame)
    if (++frames % 100 === 0) console.log(`[captions] forwarded ${frames} audio chunks, ${finals} final transcripts`)
  }
  ws.onerror = () => console.error(`[captions] cannot reach daemon audio ws ${AUDIO_WS} — is the daemon up + glasses connected?`)

  const shutdown = async () => {
    console.log("\n[captions] shutting down: mic off + disconnect")
    try { await fetch(`${DAEMON}/mic`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enable: false }) }) } catch {}
    try { ws.close() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error("[captions] fatal:", e?.message || e)
  process.exit(1)
})
