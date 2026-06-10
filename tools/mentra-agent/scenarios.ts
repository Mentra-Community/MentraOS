#!/usr/bin/env bun
/**
 * @fileoverview mentra-agent scenario runner: scripted failure-mode tests.
 *
 * Each scenario drives the app through the bridge AND the environment through
 * adb/emulator controls, asserting on both ends. This is the part that was
 * impossible against a physical phone: cutting the network there killed the
 * control channel (WiFi ADB) — on the emulator, adb rides the emulator
 * transport and survives anything we do to the virtual network.
 *
 *   bun tools/mentra-agent/scenarios.ts list
 *   bun tools/mentra-agent/scenarios.ts captions
 *   bun tools/mentra-agent/scenarios.ts reconnect
 *   bun tools/mentra-agent/scenarios.ts endpoint-switch
 *   bun tools/mentra-agent/scenarios.ts all
 *
 * Exit code is non-zero on any failure, so `all` is CI-ready.
 */

const BASE = process.env.MENTRA_AGENT_URL ?? "http://localhost:8787"
const EMU = process.env.MENTRA_AGENT_EMULATOR ?? "emulator-5554"
const AWS_CORE = "https://core.us-west-2.dev.mentraglass.com"
const AWS_RUNTIME = "https://runtime.us-west-2.dev.mentraglass.com"

// --- plumbing ----------------------------------------------------------------

async function rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({method, params, timeoutMs}),
  })
  const body = (await res.json()) as {ok: boolean; result?: unknown; error?: string}
  if (!body.ok) throw new Error(body.error ?? `rpc ${method} failed`)
  return body.result
}

async function events(since: number, filter?: string): Promise<{seq: number; event: string; data: never}[]> {
  const url = new URL(`${BASE}/events`)
  url.searchParams.set("since", String(since))
  if (filter) url.searchParams.set("filter", filter)
  return (await (await fetch(url)).json()) as never
}

function adb(args: string[]): {ok: boolean; out: string} {
  const proc = Bun.spawnSync(["adb", "-s", EMU, ...args])
  return {ok: proc.exitCode === 0, out: proc.stdout.toString() + proc.stderr.toString()}
}

function log(msg: string): void {
  console.log(`  ${msg}`)
}

async function waitFor(desc: string, timeoutS: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000
  while (Date.now() < deadline) {
    // A throwing probe means "can't tell yet" (bridge mid-failover during a
    // network drop), not failure — keep polling until the deadline.
    try {
      if (await check()) {
        log(`✓ ${desc}`)
        return
      }
    } catch {
      /* retry */
    }
    await Bun.sleep(1500)
  }
  throw new Error(`timeout (${timeoutS}s) waiting for: ${desc}`)
}

async function cloudState(): Promise<{connected: boolean; status: string; audioTransport: string}> {
  // Short timeout: state probes run inside waitFor loops during outages; a
  // hung probe must fail fast so the loop keeps polling.
  const st = (await rpc("getState", undefined, 5_000)) as {
    cloud: {connected: boolean; status: string; audioTransport: string}
  }
  return st.cloud
}

async function speechPcmBase64(phrase: string): Promise<string> {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 16)}`
  const aiff = `/tmp/mentra-scn-${stamp}.aiff`
  const wav = `/tmp/mentra-scn-${stamp}.wav`
  if (Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase]).exitCode !== 0) throw new Error("say failed")
  if (Bun.spawnSync(["/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"]).exitCode !== 0)
    throw new Error("afconvert failed")
  const buf = new Uint8Array(await Bun.file(wav).arrayBuffer())
  const idx = Buffer.from(buf).indexOf("data")
  if (idx < 0) throw new Error("no data chunk")
  return Buffer.from(buf.subarray(idx + 8)).toString("base64")
}

/** Inject a phrase and assert a transcript containing `expect` comes back. */
async function speakAndExpect(phrase: string, expect: string, timeoutS = 40): Promise<void> {
  await rpc("setSubscriptions", {subs: [{kind: "transcription", language: {mode: "specific", code: "en"}}]})
  const baseline = (await events(0)).at(-1)?.seq ?? 0
  log(`speaking: "${phrase}"`)
  await rpc("injectAudio", {pcmBase64: await speechPcmBase64(phrase)})
  let since = baseline
  try {
    await waitFor(`transcript contains "${expect}"`, timeoutS, async () => {
      const fresh = await events(since, "transcript")
      for (const e of fresh) {
        since = e.seq
        const text = (e.data as {text?: string}).text ?? ""
        if (text.toLowerCase().includes(expect.toLowerCase())) return true
      }
      return false
    })
  } catch (err) {
    // Self-documenting failure: capture the client+server picture so a
    // transcript timeout is actionable without re-running by hand. The cloud
    // can be "connected, audio flowing, provider up" yet emit nothing (see the
    // Soniox auto-pause wedge in the README findings) — that distinction is
    // exactly what these lines surface.
    await dumpDiagnostics(since)
    throw err
  }
}

/** On a captions failure, print what the app and (best-effort) the cloud saw. */
async function dumpDiagnostics(sinceSeq: number): Promise<void> {
  try {
    const cloud = await cloudState()
    log(`diag: cloud=${cloud.status}/${cloud.audioTransport}`)
  } catch {
    log("diag: cloud state unavailable")
  }
  const recent = (await events(Math.max(0, sinceSeq - 5))).slice(-6)
  for (const e of recent) log(`diag: event ${e.event} ${JSON.stringify(e.data).slice(0, 80)}`)
  // Best-effort server correlation (no-op if porter/auth unavailable in CI).
  const proc = Bun.spawnSync([
    "porter", "app", "logs", "cloud-v2", "--service", "runtime", "--since", "2m", "--limit", "40",
  ])
  if (proc.exitCode === 0) {
    const lines = proc.stdout
      .toString()
      .split("\n")
      .filter((l) => /soniox|subscriptions write|udp packet appended/.test(l))
      .slice(-4)
    for (const l of lines) log(`diag[server]: ${l.slice(0, 120)}`)
  }
}

/**
 * Force-restart the app to drop the server-side STT provider and get a clean
 * session. The Soniox auto-pause wedge (see README) survives client reconnect
 * AND unsubscribe — only a full session close (app kill -> DETACH -> provider
 * dropped) clears it. So between scenarios that churn the provider we restart
 * the app. The bridge reconnects over adb-reverse localhost; login persists.
 */
async function resetApp(): Promise<void> {
  log("resetting app (force-stop -> relaunch) for a clean STT provider")
  adb(["shell", "am", "force-stop", "com.mentra.mentra"])
  await Bun.sleep(1500)
  adb(["shell", "monkey", "-p", "com.mentra.mentra", "-c", "android.intent.category.LAUNCHER", "1"])
  // Wait for the bridge to come back, then for cloud to reconnect.
  await waitFor("bridge reconnected after restart", 60, async () => {
    try {
      await rpc("ping", undefined, 3_000)
      return true
    } catch {
      return false
    }
  })
  await ensureReady()
}

/** Shared setup: logged in, AWS endpoints, pcm codec, connected. */
async function ensureReady(): Promise<void> {
  const who = (await rpc("isLoggedIn")) as {loggedIn: boolean}
  if (!who.loggedIn) {
    // Pull QA creds the same way the CLI does.
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
    if (!email || !password) throw new Error("not logged in and QA creds unavailable")
    await rpc("login", {email, password})
    log("✓ logged in as QA user")
  }

  const core = (await rpc("getSetting", {key: "cloud_core_url"})) as {value?: unknown}
  const codec = (await rpc("getSetting", {key: "cloud_audio_codec"})) as {value?: unknown}
  let needsReconnect = false
  if (core.value !== AWS_CORE) {
    await rpc("setSetting", {key: "cloud_core_url", value: AWS_CORE})
    await rpc("setSetting", {key: "cloud_runtime_url", value: AWS_RUNTIME})
    needsReconnect = true
  }
  if (codec.value !== "pcm") {
    await rpc("setSetting", {key: "cloud_audio_codec", value: "pcm"})
    needsReconnect = true
  }
  if (needsReconnect || !(await cloudState()).connected) {
    await rpc("cloudReconnect")
  }
  await waitFor("cloud connected (AWS, pcm)", 30, async () => (await cloudState()).connected)
}

// --- scenarios ----------------------------------------------------------------

const SCENARIOS: Record<string, {desc: string; run: () => Promise<void>}> = {
  captions: {
    desc: "Baseline captions pipeline: subscribe -> inject speech -> transcript returns",
    run: async () => {
      await ensureReady()
      await speakAndExpect("The amber telescope watches the northern harbor", "amber telescope")
    },
  },

  reconnect: {
    desc: "Network drop + restore: cloud reconnects on its own and transcription resumes",
    run: async () => {
      await ensureReady()
      await speakAndExpect("Baseline check before the storm", "baseline check")

      log("cutting emulator network (wifi + data off; adb survives on emulator transport)")
      adb(["shell", "svc", "wifi", "disable"])
      adb(["shell", "svc", "data", "disable"])
      try {
        await waitFor("app reports cloud disconnected", 60, async () => !(await cloudState()).connected)
      } finally {
        log("restoring network")
        adb(["shell", "svc", "wifi", "enable"])
        adb(["shell", "svc", "data", "enable"])
      }

      await waitFor("cloud reconnected without any app interaction", 90, async () => (await cloudState()).connected)
      // The real assertion: transcription works again end-to-end (subscriptions
      // survived the new session via connection.init initialSubscriptions, the
      // server re-attached its STT provider, the UDP path re-established).
      await speakAndExpect("The violet beacon returns after the storm", "violet beacon")
    },
  },

  "udp-block": {
    desc: "UDP egress blocked: client falls back to WS audio and transcription keeps working",
    run: async () => {
      await ensureReady()
      await speakAndExpect(
        "Audio over the UDP path first as a baseline with a continuous utterance before anything is blocked",
        "continuous utterance",
      )
      const before = await cloudState()
      if (before.audioTransport !== "udp") log(`note: starting transport is ${before.audioTransport}, expected udp`)

      log("blocking UDP egress (drops audio frames + liveness probes)")
      await rpc("setUdpBlocked", {blocked: true})
      try {
        // Client probes UDP every 1s; ~3s without acks flips it to WS.
        await waitFor("audio transport falls back to ws", 20, async () => (await cloudState()).audioTransport === "ws")
        // The real assertion: audio still gets through over WS binary frames.
        // Use a LONG continuous utterance: the 3s detection window leaves a
        // silence gap that trips the Soniox auto-pause wedge (a separate, known
        // runtime bug — see README); a continuous stream keeps the engine
        // emitting so this test isolates the WS PATH, which is its job.
        await speakAndExpect(
          "Testing the websocket fallback audio path with one long continuous utterance that keeps the transcription engine emitting the whole time without any silence",
          "continuous utterance",
        )
      } finally {
        log("restoring UDP egress")
        await rpc("setUdpBlocked", {blocked: false})
      }
      // Liveness acks resume -> transport returns to udp on its own.
      await waitFor("audio transport recovers to udp", 20, async () => (await cloudState()).audioTransport === "udp")
      await speakAndExpect(
        "Back on the UDP path again with another long continuous utterance confirming transcription recovered after the websocket fallback ended",
        "transcription recovered",
      )
    },
  },

  "endpoint-switch": {
    desc: "Endpoint override flow: bogus endpoint disconnects, switching back recovers",
    run: async () => {
      await ensureReady()
      log("pointing cloud at a bogus endpoint")
      await rpc("setSetting", {key: "cloud_core_url", value: "https://bogus.invalid"})
      await rpc("setSetting", {key: "cloud_runtime_url", value: "https://bogus.invalid"})
      await rpc("cloudReconnect")
      try {
        await waitFor("app reports disconnected on bogus endpoint", 30, async () => !(await cloudState()).connected)
      } finally {
        log("switching back to AWS")
        await rpc("setSetting", {key: "cloud_core_url", value: AWS_CORE})
        await rpc("setSetting", {key: "cloud_runtime_url", value: AWS_RUNTIME})
        await rpc("cloudReconnect")
      }
      await waitFor("reconnected to AWS", 45, async () => (await cloudState()).connected)
      // Continuous utterance: the bogus->AWS reconnect leaves a silence gap
      // that would trip the auto-pause wedge with a short phrase.
      await speakAndExpect(
        "The scarlet compass finds the harbor again after a long continuous utterance confirming transcription works once the real endpoint is restored",
        "scarlet compass",
      )
    },
  },
}

// --- main ----------------------------------------------------------------------

const arg = process.argv[2]
if (!arg || arg === "list") {
  for (const [name, s] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(18)} ${s.desc}`)
  process.exit(0)
}

const names = arg === "all" ? Object.keys(SCENARIOS) : [arg]
const noReset = process.argv.includes("--no-reset")
let failed = 0
for (let i = 0; i < names.length; i++) {
  const name = names[i]
  const scenario = SCENARIOS[name]
  if (!scenario) {
    console.error(`unknown scenario: ${name}`)
    process.exit(1)
  }
  // Reset the app before each scenario (except the first) in a multi-scenario
  // run so a prior scenario's wedged STT provider can't fail the next one.
  // Skippable with --no-reset for a faster (but cross-contaminated) run.
  if (i > 0 && names.length > 1 && !noReset) {
    try {
      await resetApp()
    } catch (err) {
      console.error(`  reset before ${name} failed: ${(err as Error).message}`)
    }
  }
  console.log(`\n=== ${name}: ${scenario.desc}`)
  const started = Date.now()
  try {
    await scenario.run()
    console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)}s)`)
  } catch (err) {
    failed += 1
    console.error(`FAIL ${name}: ${(err as Error).message}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
