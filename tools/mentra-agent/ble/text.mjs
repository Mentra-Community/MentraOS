// Display text on a real Even G2 from the Mac.
//
//   ../run.sh text.mjs "G2_32" "Hello from the harness" 20
//     arg1 = serial/name substring identifying YOUR glasses (matches both L & R arms)
//     arg2 = text to show
//     arg3 = seconds to hold the page alive (heartbeats) before disconnecting
//
// Flow (ported from G2.kt): connect both arms -> subscribe notify 5402 ->
// auth(L), auth(R), pipe-role(R), time-sync(R) -> CREATE_STARTUP_PAGE(text) to
// both -> heartbeats -> hold -> disconnect.
//
// WRITES to the hardware (draws text). Only ever targets the arms whose name
// matches the given substring, so it can't touch anyone else's glasses.

import noble from "@abandonware/noble"
import { writeFileSync } from "node:fs"
import * as g2 from "./g2.mjs"

const argv = process.argv.slice(1).filter((a) => !a.endsWith("text.mjs"))
const outIdx = argv.indexOf("--out")
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null
const pos = argv.filter((a, i) => a !== "--out" && i !== outIdx + 1)
const MATCH = pos[0] || "G2_"
const TEXT = pos[1] || "Hello from the MentraOS harness"
const HOLD_S = Number(pos[2] || 20)
const SCAN_S = Number(pos[3] || 35) // max wait; proceeds early once both arms appear (env doesn't survive `open`)
const logPath = OUT ? OUT.replace(/\.json$/, "") + ".log" : null

const WRITE = "5401"
const NOTIFY = "5402"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = []
function note(m) {
  log.push(m)
  if (logPath) { try { writeFileSync(logPath, log.join("\n") + "\n") } catch {} }
  else console.error(m)
}
function finish(obj) {
  obj.log = log
  if (OUT) { try { writeFileSync(OUT, JSON.stringify(obj, null, 2)) } catch {} }
  else console.log(JSON.stringify(obj, null, 2))
  process.exit(obj.ok ? 0 : 1)
}

const arms = { L: null, R: null } // { peripheral, writeChar }
const send = new g2.SendManager()

let proceeded = false
noble.on("stateChange", async (s) => {
  if (s === "poweredOn") {
    note(`[text] waiting up to ${SCAN_S}s for "${MATCH}" (wake the glasses now)...`)
    await noble.startScanningAsync([], false)
    setTimeout(() => go("timeout"), SCAN_S * 1000)
  } else note(`[text] bluetooth ${s}`)
})

// Match on the FIXED factory serial (from mfg data), not the name suffix — so a
// colleague's G2 in the same group can never match. Side (L/R) still comes from
// the name; both arms of one unit share the serial.
function decodeSerial(buf) {
  if (!buf) return null
  let best = "", cur = ""
  for (const b of buf) {
    if (b >= 0x30 && b <= 0x5a) cur += String.fromCharCode(b)
    else { if (cur.length > best.length) best = cur; cur = "" }
  }
  if (cur.length > best.length) best = cur
  return best.length >= 6 ? best : null
}

const found = new Map()
const m = MATCH.toLowerCase()
noble.on("discover", (p) => {
  const name = p.advertisement?.localName || ""
  const serial = decodeSerial(p.advertisement?.manufacturerData) || ""
  // Require the match to hit the serial, or an explicit full name — never a bare group prefix.
  const hit = serial.toLowerCase().includes(m) || name.toLowerCase().includes(m)
  if (!hit) return
  const side = /_L_|_L$/.test(name) ? "L" : /_R_|_R$/.test(name) ? "R" : null
  if (side && !found.has(side)) {
    found.set(side, p)
    note(`[text] found ${side}: ${name} (serial ${serial || "?"})`)
    if (found.has("L") && found.has("R")) go("both-arms") // proceed the instant both are up
  }
})

function go(reason) {
  if (proceeded) return
  proceeded = true
  note(`[text] proceeding (${reason}); arms: ${[...found.keys()].sort().join("+") || "none"}`)
  connectArms()
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

async function setupArm(side, p) {
  note(`[text] connecting ${side} (${p.advertisement.localName})...`)
  await withTimeout(p.connectAsync(), 12000, `${side} connect`)
  const { characteristics } = await p.discoverAllServicesAndCharacteristicsAsync()
  const writeChar = characteristics.find((c) => c.uuid.endsWith(WRITE))
  const notifyChar = characteristics.find((c) => c.uuid.endsWith(NOTIFY))
  if (!writeChar) throw new Error(`${side}: no write char (…${WRITE})`)
  if (notifyChar) {
    await notifyChar.subscribeAsync()
    notifyChar.on("data", (d) => note(`[text] ${side} notify: ${d.toString("hex").slice(0, 40)}`))
  }
  arms[side] = { peripheral: p, writeChar }
  note(`[text] ${side} ready`)
}

// write packets to the chosen arm(s); 5401 is writeWithoutResponse
async function writePackets(packets, { left = false, right = true }) {
  for (const pkt of packets) {
    if (left && arms.L) await arms.L.writeChar.writeAsync(pkt, true)
    if (right && arms.R) await arms.R.writeChar.writeAsync(pkt, true)
    if (packets.length > 1) await sleep(30)
  }
}
const sendDevSettings = (payload, lr) =>
  writePackets(send.packets(g2.ServiceID.DEVICE_SETTINGS, payload), lr)
const sendEvenHub = (payload) =>
  writePackets(send.packets(g2.ServiceID.EVEN_HUB, payload, true), { left: true, right: true })

async function connectArms() {
  await noble.stopScanningAsync()
  if (!found.has("L") && !found.has("R")) {
    return finish({ ok: false, error: `no arms matched "${MATCH}" — wake/​unfold the glasses and retry` })
  }
  try {
    // Set up each arm independently — a timeout on one shouldn't abort the other.
    for (const side of ["L", "R"]) {
      if (found.has(side)) {
        try { await setupArm(side, found.get(side)) }
        catch (e) { note(`[text] ${side} setup failed: ${e.message || e}`) }
      }
    }
    if (!arms.L && !arms.R) return finish({ ok: false, error: "no arm connected (all timed out)" })

    // ---- auth sequence (G2.kt runAuthSequence, core subset) ----
    note("[text] auth sequence...")
    if (arms.L) await sendDevSettings(g2.authCmd(send.nextMagic()), { left: true, right: false })
    await sleep(200)
    if (arms.R) await sendDevSettings(g2.authCmd(send.nextMagic()), { left: false, right: true })
    await sleep(200)
    if (arms.R) await sendDevSettings(g2.pipeRoleChange(send.nextMagic()), { left: false, right: true })
    await sleep(200)
    const tzSec = -new Date().getTimezoneOffset() * 60
    await sendDevSettings(g2.timeSync(send.nextMagic(), Date.now(), tzSec), { left: false, right: true })
    await sleep(300)

    // ---- display text ----
    note(`[text] CREATE_STARTUP_PAGE: "${TEXT}"`)
    await sendEvenHub(g2.defaultTextPage(TEXT, send.nextMagic()))

    // ---- heartbeats while holding the page ----
    note(`[text] holding ${HOLD_S}s with heartbeats...`)
    const evenHb = setInterval(() => sendEvenHub(g2.heartbeatMessage(send.nextMagic())).catch(() => {}), 10000)
    const devHb = setInterval(
      () => sendDevSettings(g2.baseHeartbeat(send.nextMagic()), { left: false, right: true }).catch(() => {}),
      5000,
    )
    await sleep(HOLD_S * 1000)
    clearInterval(evenHb)
    clearInterval(devHb)

    note("[text] disconnecting")
    if (arms.L) await arms.L.peripheral.disconnectAsync().catch(() => {})
    if (arms.R) await arms.R.peripheral.disconnectAsync().catch(() => {})
    finish({ ok: true, displayed: TEXT, arms: { L: !!arms.L, R: !!arms.R } })
  } catch (e) {
    try { if (arms.L) await arms.L.peripheral.disconnectAsync() } catch {}
    try { if (arms.R) await arms.R.peripheral.disconnectAsync() } catch {}
    finish({ ok: false, error: String(e), arms: { L: !!arms.L, R: !!arms.R } })
  }
}
