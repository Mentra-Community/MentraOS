// button-to-lens: press the Mentra Live's camera button -> photo renders on
// the Even G2 lens. Bridges the two daemons (Live :8899, G2 :8799).
//
//   node button-to-lens.mjs [--live 8899] [--g2 8799] [--no-negate] [--no-flip]
//
// Loop: poll Live /liveEvents for button gestures -> trigger /photo (wifi
// webhook back to the Live daemon's media receiver) -> wait for the JPEG ->
// ffmpeg gray 224x140 (gamma boost + normalize, optional 180-flip + negate)
// -> G2 /image {tiled} (4 single-fragment strips; see CONFORMANCE.md for why).

import { execFileSync } from "node:child_process"
import { ditherTo16 } from "./bmp.mjs"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const LIVE = `http://127.0.0.1:${opt("live", "8899")}`
const G2 = `http://127.0.0.1:${opt("g2", "8799")}`
const NEGATE = !args.includes("--no-negate")
const FLIP = args.includes("--flip") // force-flip override; otherwise the Live's IMU decides per photo
const W = 224, H = 140
const PHOTO_DIR = join(dirname(fileURLToPath(import.meta.url)), "photos")

const log = (m) => console.log(`${new Date().toISOString()} ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (base, p) => (await fetch(base + p, { signal: AbortSignal.timeout(10000) })).json()
const post = async (base, p, body, timeoutMs = 30000) =>
  (await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs) })).json()

function newestPhoto() {
  const files = readdirSync(PHOTO_DIR).filter((f) => f.endsWith(".jpg") || f.endsWith(".jpeg"))
  let best = null
  for (const f of files) {
    const m = statSync(join(PHOTO_DIR, f)).mtimeMs
    if (!best || m > best.m) best = { f: join(PHOTO_DIR, f), m }
  }
  return best
}

function toLensGray(jpegPath, flipNow) {
  const flt = [
    flipNow ? "hflip,vflip" : null,
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    "eq=gamma=1.5:contrast=1.3",
    "normalize",
    NEGATE ? "negate" : null,
  ].filter(Boolean).join(",")
  const out = `/tmp/btl-${Date.now()}.raw`
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", jpegPath, "-vf", flt, "-pix_fmt", "gray", "-f", "rawvideo", out])
  return readFileSync(out)
}

async function showOnG2(gray) {
  const d = ditherTo16({ w: W, h: H, data: new Uint8Array(gray) })
  return post(G2, "/image", { tiled: true, grayBase64: Buffer.from(d.data).toString("base64"), width: W, height: H })
}

async function snapAndShow(trigger) {
  log(`${trigger}: waiting out the button's own on-device capture...`)
  // a button press makes the glasses capture locally; an immediate take_photo
  // collides with the busy camera (media_error) — give it a beat first
  await sleep(2500)
  log(`${trigger}: capturing...`)
  // camera orientation from the Live's IMU: gravity z > +3 means upside down
  let flipNow = FLIP
  try {
    const st = await get(LIVE, "/status")
    const z = st?.imu?.accel?.[2]
    if (typeof z === "number") flipNow = FLIP || z > 3
    log(`imu z=${z?.toFixed?.(2)} -> flip=${flipNow}`)
  } catch {}
  const before = newestPhoto()
  // fire-and-forget: the daemon's take_photo HTTP reply can hang (no device
  // confirmation on this path) — the photo arrives via the webhook regardless
  post(LIVE, "/photo", { transferMethod: "wifi" }, 45000).catch(() => {})
  // wait up to 20s for a new JPEG to land via the webhook
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const now = newestPhoto()
    if (now && (!before || now.m > before.m)) {
      log(`photo landed: ${now.f}`)
      const res = await showOnG2(toLensGray(now.f, flipNow))
      log(`lens: ${JSON.stringify(res)}`)
      return
    }
  }
  log("no photo arrived within 20s")
}

let lastSeen = new Date().toISOString()
await post(LIVE, "/imu", { enable: true }, 8000).catch(() => {})
log(`button-to-lens up: Live=${LIVE} G2=${G2} negate=${NEGATE} flip=${FLIP ? "forced" : "auto (IMU)"}`)
log(`press the Mentra Live's camera button...`)
let busy = false
for (;;) {
  try {
    const { events } = await get(LIVE, "/liveEvents")
    const fresh = (events || []).filter((e) => e.at > lastSeen && e.kind === "gesture" && String(e.gesture || "").startsWith("button"))
    if (fresh.length) {
      lastSeen = fresh[fresh.length - 1].at
      if (!busy) {
        busy = true
        await snapAndShow(fresh[fresh.length - 1].gesture).catch((e) => log(`error: ${e.message}`))
        busy = false
      }
    }
  } catch (e) {
    log(`poll error: ${e.message}`)
    await sleep(2000)
  }
  await sleep(700)
}
