// Connect to ONE specific Even device by name substring, enumerate its GATT
// table, and classify the protocol (G1 Nordic-UART vs G2 EvenHub). Then leave.
//
// This is intentionally a read-only prober: it connects, reads MTU + services +
// characteristics, reports, and disconnects. No commands are written to the
// glasses, so it is safe to run against your own hardware to learn the layout.
//
//   ../run.sh connect.mjs "G1_34_L_484B26"
//
// The name substring MUST uniquely identify YOUR glasses — in a room with other
// Even devices, pass enough of the serial suffix to be unambiguous. The script
// refuses to connect if the substring matches more than one device.

import noble from "@abandonware/noble"
import { writeFileSync } from "node:fs"

const argv = process.argv.slice(1).filter((a) => !a.endsWith("connect.mjs"))
const outIdx = argv.indexOf("--out")
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null
const MATCH = argv.find((a) => a !== "--out" && a !== OUT && !/^\d+$/.test(a))
const SCAN_S = Number(argv.find((a) => /^\d+$/.test(a)) || 12)
const logPath = OUT ? OUT.replace(/\.json$/, "") + ".log" : null

// G2 real hardware exposes a FAMILY of 00002760-...-0e8ac72eXXXX services
// (commands on ...5450/5401/5402, audio on ...6450/6402) AND a legacy Nordic
// UART service. So detect G2 by the family base, not one exact UUID — otherwise
// the co-present UART service makes a G2 look like a G1.
const G2_FAMILY = "276008c211e190730e8ac72e"
const G1_SVC = "6e400001b5a3f393e0a9e50e24dcca9e"
const norm = (u) => u.replace(/-/g, "").toLowerCase()

function note(m) {
  if (logPath) { try { writeFileSync(logPath, m + "\n", { flag: "a" }) } catch {} }
  else console.error(m)
}
function finish(obj) {
  if (OUT) { try { writeFileSync(OUT, JSON.stringify(obj, null, 2)) } catch {} }
  else console.log(JSON.stringify(obj, null, 2))
  process.exit(obj.error ? 1 : 0)
}

if (!MATCH) finish({ error: "no name substring given — pass the serial suffix of YOUR glasses" })

const matches = new Map()
let timer = null

noble.on("stateChange", async (s) => {
  if (s === "poweredOn") {
    note(`[connect] scanning ${SCAN_S}s for "${MATCH}"...`)
    await noble.startScanningAsync([], false)
    timer = setTimeout(() => decide(), SCAN_S * 1000)
  } else note(`[connect] bluetooth ${s}`)
})

noble.on("discover", (p) => {
  const name = p.advertisement?.localName || ""
  if (name && name.toLowerCase().includes(MATCH.toLowerCase())) matches.set(p.id, p)
})

async function decide() {
  await noble.stopScanningAsync()
  const list = [...matches.values()]
  if (list.length === 0) return finish({ error: `no advertising device matched "${MATCH}" — wake/​unfold the glasses and retry` })
  if (list.length > 1)
    return finish({
      error: `"${MATCH}" matched ${list.length} devices — be more specific`,
      candidates: list.map((p) => p.advertisement.localName),
    })
  await probe(list[0])
}

async function probe(p) {
  const name = p.advertisement.localName
  note(`[connect] connecting to ${name}...`)
  const result = { device: name, address: p.address || p.id, rssi: p.rssi, services: [] }
  try {
    p.once("disconnect", () => note(`[connect] disconnected`))
    await p.connectAsync()
    result.mtu = p.mtu || null
    note(`[connect] connected; mtu=${result.mtu}. discovering services...`)
    const services = await p.discoverServicesAsync([])
    for (const svc of services) {
      const chars = await svc.discoverCharacteristicsAsync([])
      result.services.push({
        uuid: svc.uuid,
        characteristics: chars.map((c) => ({ uuid: c.uuid, properties: c.properties })),
      })
    }
    const all = result.services.map((s) => norm(s.uuid))
    result.protocol = all.some((u) => u.includes(G2_FAMILY))
      ? "G2 (EvenHub/protobuf)"
      : all.includes(G1_SVC)
        ? "G1 (Nordic UART)"
        : "unknown"
    note(`[connect] protocol = ${result.protocol}`)
    await p.disconnectAsync()
    finish(result)
  } catch (e) {
    result.error = String(e)
    try { await p.disconnectAsync() } catch {}
    finish(result)
  }
}
