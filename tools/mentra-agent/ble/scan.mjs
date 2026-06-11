// Passive BLE scan for Even Realities glasses.
//
// This only LISTENS to advertisements — it never connects — so it cannot
// disturb a pairing the glasses may currently hold with a phone.
//
// It prints each Even arm's advertised name + service UUIDs, which is what
// tells us whether the hardware speaks the G1 protocol (Nordic UART,
// 6e400001-...) or the G2 protocol (EvenHub, 00002760-...-0e8ac72e0000).
//
// Run:  node ble/scan.mjs            (scans ~10s, then prints a table)
//       node ble/scan.mjs 20         (scan for 20s)
//
// macOS will prompt once for Bluetooth access for the host terminal app the
// first time this runs. Approve it, or the scan finds nothing.

import noble from "@abandonware/noble"
import { writeFileSync } from "node:fs"

// Args may arrive two ways:
//   direct:            node scan.mjs [seconds]
//   via `open --args`: <bundle>/node <abs script> [seconds] --out <file>
// so parse positionally-but-tolerantly and support --out for the LaunchServices path.
const argv = process.argv.slice(1).filter((a) => !a.endsWith("scan.mjs"))
const outIdx = argv.indexOf("--out")
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null
const SECONDS = Number(argv.find((a) => /^\d+$/.test(a)) || 10)
const logPath = OUT ? OUT.replace(/\.json$/, "") + ".log" : null
function note(msg) {
  if (logPath) {
    try { writeFileSync(logPath, msg + "\n", { flag: "a" }) } catch {}
  } else {
    console.error(msg)
  }
}

// Known service UUIDs (lowercased, no dashes — how noble reports them).
const G1_SVC = "6e400001b5a3f393e0a9e50e24dcca9e"
const G2_SVC = "0000276008c211e190730e8ac72e0000"

const seen = new Map() // id -> record

// The Even mfg-data carries the fixed factory serial as ASCII (G1: after a side
// flag byte; G2: after the 2-byte company id). Rather than guess the layout,
// pull the longest printable-ASCII run — that's the serial (e.g. RS211GABA063248).
function decodeSerial(buf) {
  let best = ""
  let cur = ""
  for (const b of buf) {
    if (b >= 0x30 && b <= 0x5a) cur += String.fromCharCode(b) // 0-9 A-Z
    else {
      if (cur.length > best.length) best = cur
      cur = ""
    }
  }
  if (cur.length > best.length) best = cur
  return best.length >= 6 ? best : null
}

function classify(uuids) {
  const u = uuids.map((x) => x.replace(/-/g, "").toLowerCase())
  if (u.includes(G2_SVC)) return "G2 (EvenHub/protobuf)"
  if (u.includes(G1_SVC)) return "G1 (Nordic UART)"
  return null
}

// Identify the Mentra/Even glasses family from the advertised name. The full
// driver support differs per family — see README.
function family(name) {
  const n = (name || "").toLowerCase()
  if (/even g2|g2_/i.test(name)) return "Even G2 (driven)"
  if (/even g1|g1_/i.test(name)) return "Even G1 (driven)"
  if (/^nex1-|mentra_display/i.test(name)) return "Mentra Nex/Display (protobuf; port staged)"
  if (/mentra_live|mentra live/i.test(name)) return "Mentra Live (camera; JSON/K900; port staged)"
  if (/mach1/i.test(name)) return "Mach1 (camera; port staged)"
  if (/even r1/i.test(name)) return "Even R1 (ring)"
  return "unknown"
}

let lastState = "unknown"
noble.on("stateChange", async (state) => {
  lastState = state
  if (state === "poweredOn") {
    note(`[scan] Bluetooth powered on — scanning ${SECONDS}s for Even devices...`)
    // empty filter + allowDuplicates so we catch both L and R arms and read RSSI
    await noble.startScanningAsync([], true)
  } else {
    note(`[scan] Bluetooth state: ${state}`)
  }
})

noble.on("discover", (p) => {
  const name = p.advertisement?.localName || ""
  const svcs = p.advertisement?.serviceUuids || []
  // Match all known Mentra/Even glasses families.
  const isGlasses = /even|g1|g2|nex1|mentra|mach1|display/i.test(name) || classify(svcs)
  if (!isGlasses) return
  const rec = seen.get(p.id) || {}
  rec.name = name || rec.name || "(no name)"
  rec.address = p.address && p.address !== "" ? p.address : rec.address || p.id
  rec.rssi = p.rssi
  rec.serviceUuids = svcs.length ? svcs : rec.serviceUuids || []
  rec.proto = classify(rec.serviceUuids) || rec.proto || null
  rec.family = family(rec.name)
  const mfg = p.advertisement?.manufacturerData
  if (mfg) {
    rec.mfg = mfg.toString("hex")
    rec.serial = decodeSerial(mfg) // the fixed factory serial (e.g. ...063248), unlike the rotating name suffix
  }
  seen.set(p.id, rec)
})

setTimeout(async () => {
  try {
    await noble.stopScanningAsync()
  } catch {}
  const rows = [...seen.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""))
  if (OUT) {
    // LaunchServices path: results go to a file the harness reads back.
    try {
      writeFileSync(OUT, JSON.stringify({ state: lastState, count: rows.length, devices: rows }, null, 2))
      note(`[scan] wrote ${rows.length} device(s) -> ${OUT}`)
    } catch (e) {
      note(`[scan] failed to write ${OUT}: ${e}`)
    }
    process.exit(0)
  }
  console.log("\n=== Even devices found ===")
  if (!rows.length) {
    console.log("  (none) — glasses asleep/out of range, or Bluetooth permission was denied.")
  }
  for (const r of rows) {
    const side = /_L_|_L$|\bL\b/.test(r.name) ? "LEFT" : /_R_|_R$|\bR\b/.test(r.name) ? "RIGHT" : "?"
    console.log(`\n  ${r.name}   [${side}]  rssi ${r.rssi}`)
    console.log(`    address:      ${r.address}`)
    console.log(`    protocol:     ${r.proto || "unknown (no recognized service advertised)"}`)
    console.log(`    serviceUuids: ${(r.serviceUuids || []).join(", ") || "(none advertised)"}`)
    if (r.mfg) console.log(`    mfgData:      ${r.mfg}`)
  }
  console.log("")
  process.exit(0)
}, SECONDS * 1000)
