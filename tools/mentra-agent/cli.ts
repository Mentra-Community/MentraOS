#!/usr/bin/env bun
/**
 * @fileoverview mentra-agent CLI: drive the running MentraOS app from a shell.
 *
 * Talks to the harness server (server.ts) over its local HTTP control plane;
 * the server relays to the app's dev-only bridge over the reverse WebSocket.
 * Designed so an agent (or a human) can replace minutes of screen-driving
 * with sub-second calls:
 *
 *   bun cli.ts state                              # cloud status, endpoints, transport
 *   bun cli.ts nav /miniapps/settings/developer   # navigate anywhere
 *   bun cli.ts set cloud_core_url metro-auto      # write a setting
 *   bun cli.ts get cloud_core_url                 # read a setting
 *   bun cli.ts login                              # sign in as the QA test user
 *   bun cli.ts launch com.mentra.local-captions   # launch a local miniapp
 *   bun cli.ts reconnect                          # bounce the cloud client
 *   bun cli.ts devices                            # connected app instances
 *   bun cli.ts events --filter transcript         # dump recent events
 *   bun cli.ts watch transcript                   # follow events live
 *   bun cli.ts rpc <method> '<json-params>'       # raw escape hatch
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

async function getEvents(since: number, filter?: string): Promise<{seq: number; event: string; data: unknown; receivedAt: string}[]> {
  const url = new URL(`${BASE}/events`)
  url.searchParams.set("since", String(since))
  if (filter) url.searchParams.set("filter", filter)
  const res = await fetch(url)
  return (await res.json()) as never
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/**
 * Text -> 16 kHz mono signed-16 PCM via macOS `say` + `afconvert` (the same
 * recipe the cloud-v2 soniox e2e uses). Deterministic input audio with a known
 * transcript, no speakers or air gap involved.
 */
async function speechPcm(phrase: string): Promise<Uint8Array> {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 16)}`
  const aiff = `/tmp/mentra-agent-say-${stamp}.aiff`
  const wav = `/tmp/mentra-agent-say-${stamp}.wav`
  const say = Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase])
  if (say.exitCode !== 0) throw new Error(`say failed: ${say.stderr}`)
  const conv = Bun.spawnSync(["/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"])
  if (conv.exitCode !== 0) throw new Error(`afconvert failed: ${conv.stderr}`)
  const buf = new Uint8Array(await Bun.file(wav).arrayBuffer())
  // Locate the WAV "data" chunk; PCM follows the 8-byte chunk header.
  const idx = Buffer.from(buf).indexOf("data")
  if (idx < 0) throw new Error("no data chunk in WAV")
  return buf.subarray(idx + 8)
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/**
 * The pipeline test in one command: subscribe -> inject spoken audio -> wait
 * for a transcript containing the expectation. Exits non-zero on miss, so it
 * doubles as a CI check.
 */
async function speak(args: string[]): Promise<void> {
  const phrase = args[0]
  if (!phrase) throw new Error('usage: speak "<text>" [--expect "<substring>"] [--lang en-US] [--timeout 30]')
  const expectIdx = args.indexOf("--expect")
  const expect = expectIdx >= 0 ? args[expectIdx + 1] : undefined
  const langIdx = args.indexOf("--lang")
  // Bare ISO 639-1 code: Soniox rejects BCP-47 region hints ("Invalid
  // language hint." for en-US). The captions miniapp sends bare codes too.
  const lang = langIdx >= 0 ? args[langIdx + 1] : "en"
  const timeoutIdx = args.indexOf("--timeout")
  const timeoutS = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 30

  // Injected audio is raw PCM; the session must announce codec "pcm" or the
  // server LC3-decodes the frames into garbage. Self-heal: set + reconnect.
  const codec = (await rpc("getSetting", {key: "cloud_audio_codec"})) as {value?: unknown}
  if (codec.value !== "pcm") {
    console.error('cloud_audio_codec is not "pcm" — setting it and reconnecting...')
    await rpc("setSetting", {key: "cloud_audio_codec", value: "pcm"})
    await rpc("cloudReconnect")
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(1000)
      const st = (await rpc("getState")) as {cloud: {connected: boolean}}
      if (st.cloud.connected) break
    }
  }

  console.error(`subscribing transcription:${lang} ...`)
  await rpc("setSubscriptions", {subs: [{kind: "transcription", language: {mode: "specific", code: lang}}]})

  const baseline = (await getEvents(0)).at(-1)?.seq ?? 0
  console.error(`speaking: "${phrase}"`)
  const pcm = await speechPcm(phrase)
  const injected = (await rpc("injectAudio", {pcmBase64: b64(pcm)})) as {framesSent: number; seconds: number}
  console.error(`injected ${injected.framesSent} frames (${injected.seconds}s of audio); waiting for transcript...`)

  const deadline = Date.now() + timeoutS * 1000
  let since = baseline
  const seen: string[] = []
  while (Date.now() < deadline) {
    const fresh = await getEvents(since, "transcript")
    for (const e of fresh) {
      since = e.seq
      const data = e.data as {text?: string; isFinal?: boolean}
      const line = `${data.isFinal ? "FINAL  " : "interim"} ${data.text ?? ""}`
      console.log(line)
      if (data.text) seen.push(data.text)
      if (expect && data.text?.toLowerCase().includes(expect.toLowerCase())) {
        console.log(`\nPASS: transcript contained "${expect}"`)
        return
      }
    }
    await Bun.sleep(500)
  }
  if (expect) {
    console.error(`\nFAIL: "${expect}" not found within ${timeoutS}s. Saw: ${seen.join(" | ") || "(nothing)"}`)
    process.exit(1)
  }
}

/**
 * Resolve QA test credentials WITHOUT putting secrets on the command line:
 * explicit env first, else Doppler (cloud-v2/dev). The password reaches the
 * app only over the loopback bridge, and only in dev builds.
 */
async function qaCredentials(): Promise<{email: string; password: string}> {
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
  if (!email || !password) {
    throw new Error("QA creds not found (set QA_TEST_EMAIL/QA_TEST_PASSWORD or Doppler cloud-v2/dev)")
  }
  return {email, password}
}

const [cmd, ...args] = process.argv.slice(2)

try {
  switch (cmd) {
    case "state":
      out(await rpc("getState"))
      break
    case "ping":
      out(await rpc("ping"))
      break
    case "nav":
      out(await rpc("navigate", {path: args[0]}))
      break
    case "back":
      out(await rpc("goBack"))
      break
    case "home":
      out(await rpc("goHome"))
      break
    case "get":
      out(await rpc("getSetting", {key: args[0]}))
      break
    case "set": {
      let value: unknown = args[1]
      try {
        value = JSON.parse(args[1])
      } catch {
        /* keep as string */
      }
      out(await rpc("setSetting", {key: args[0], value}))
      break
    }
    case "launch":
      out(await rpc("launchMiniapp", {packageName: args[0]}))
      break
    case "install-miniapp":
      // Load + run a local miniapp from a `mentra-miniapp dev` server URL.
      // e.g. install-miniapp http://10.0.2.2:3120  (emulator -> host port 3120)
      out(await rpc("installDevMiniapp", {url: args[0]}))
      break
    case "speak":
      await speak(args)
      break
    case "subscribe":
      out(
        await rpc("setSubscriptions", {
          subs: [{kind: "transcription", language: {mode: "specific", code: args[0] ?? "en"}}],
        }),
      )
      break
    case "login":
      out(await rpc("login", await qaCredentials()))
      break
    case "logout":
      out(await rpc("logout"))
      break
    case "whoami":
      out(await rpc("isLoggedIn"))
      break
    case "reconnect":
      out(await rpc("cloudReconnect"))
      break
    case "devices":
      out(await (await fetch(`${BASE}/devices`)).json())
      break
    case "events": {
      const filter = args[0] === "--filter" ? args[1] : undefined
      out(await getEvents(0, filter))
      break
    }
    case "watch": {
      // Poll-follow the event ring (1s cadence is plenty for a dev harness).
      const filter = args[0]
      let since = (await getEvents(0)).at(-1)?.seq ?? 0
      console.error(`watching${filter ? ` filter=${filter}` : ""} (ctrl-c to stop)`)
      for (;;) {
        const fresh = await getEvents(since, filter)
        for (const e of fresh) {
          since = e.seq
          console.log(`${e.receivedAt} ${e.event} ${JSON.stringify(e.data)}`)
        }
        await Bun.sleep(1000)
      }
    }
    case "rpc":
      out(await rpc(args[0], args[1] ? JSON.parse(args[1]) : undefined))
      break
    default:
      console.log(
        "usage: mentra-agent <state|ping|login|logout|whoami|nav|back|home|get|set|launch|reconnect|devices|events|watch|rpc>",
      )
      process.exit(cmd ? 1 : 0)
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
}
