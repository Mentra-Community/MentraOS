// glasses daemon — a long-running process that holds ONE live G2Manager and
// exposes a localhost HTTP control API. Launched once inside MentraBLE.app (so
// it keeps the CoreBluetooth grant) and stays alive across many commands, so
// the glasses stay connected while you drive them.
//
//   launched by gd.sh:  open -n MentraBLE.app --args <abs daemon.mjs> --port 8799
//   talk to it with:    glasses.mjs  (or curl 127.0.0.1:8799/...)
//
// Endpoints:
//   GET  /status            -> manager status JSON
//   GET  /logs              -> recent log lines
//   POST /connect {serial,waitMs}
//   POST /text {text}
//   POST /clear
//   POST /mic {enable}
//   POST /disconnect
//   POST /shutdown          -> exit the daemon

import http from "node:http"
import net from "node:net"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs"
import { WebSocketServer } from "ws"
import { G2Manager } from "./manager.mjs"
import * as bmp from "./bmp.mjs"

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG_FILE = join(DIR, "daemon.log")
const PID_FILE = join(DIR, "daemon.pid")
const portIdx = process.argv.indexOf("--port")
const PORT = Number(portIdx >= 0 ? process.argv[portIdx + 1] : 8799)

const logs = []
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`
  logs.push(stamped)
  if (logs.length > 500) logs.shift()
  try { appendFileSync(LOG_FILE, stamped + "\n") } catch {}
}

const mgr = new G2Manager()
mgr.on("log", (m) => log(m))
mgr.on("state", (s) => log(`state: ${JSON.stringify(s)}`))
mgr.on("gesture", (g) => log(`gesture: ${g.gesture}`))
mgr.on("status", (s) => log(`device: battery=${s.battery ?? "?"} charging=${s.charging ?? "?"} fw=${s.rightFirmware ?? s.leftFirmware ?? "?"}`))
mgr.on("photo", (p) => log(`photo: ${JSON.stringify(p)}`))
mgr.on("liveEvent", (e) => log(`live: ${e.type ?? JSON.stringify(e)}`))

// Keep a ring buffer of the most recent decoded events (full detail) so the e2e
// probe can read back what the glasses actually sent.
const events = []
function pushEvent(kind, data) {
  events.push({ at: new Date().toISOString(), kind, ...data })
  if (events.length > 200) events.shift()
}
mgr.on("status", (s) => pushEvent("status", s))
mgr.on("gesture", (g) => pushEvent("gesture", g))
mgr.on("photo", (p) => pushEvent("photo", p))
mgr.on("liveEvent", (e) => pushEvent("liveEvent", e))

// ---------------------------------------------------------------------------
// Media receiver: the laptop-side endpoint Mentra Live uploads photos to.
//
// The glasses' unmanaged WiFi photo path POSTs multipart/form-data (parts:
// photo=<jpeg>, requestId, type, success) to the take_photo webhookUrl. We run
// a small HTTP server on 0.0.0.0:PORT+2 so the glasses can reach it over the
// LAN (or via `adb reverse` on USB), parse the multipart, and save the image.
// BLE-transferred photos (assembled by the manager from 72FF file packets)
// land in the same directory.
// ---------------------------------------------------------------------------
const MEDIA_PORT = PORT + 2
const PHOTO_DIR = join(DIR, "photos")
try { mkdirSync(PHOTO_DIR, { recursive: true }) } catch {}
const photos = [] // { at, file, bytes, source, fields }

function lanIp() {
  const ifs = os.networkInterfaces()
  // Prefer en0 (Mac WiFi), then any non-internal IPv4.
  for (const name of ["en0", "en1", ...Object.keys(ifs)]) {
    for (const a of ifs[name] ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address
    }
  }
  return null
}

// Minimal multipart/form-data parser (boundary framing per RFC 2046, which is
// all okhttp emits). Returns { fields: {name: string}, files: [{name, filename, data}] }.
function parseMultipart(body, contentType) {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType || "")
  if (!m) return null
  const delim = Buffer.from(`--${m[2]}`)
  const out = { fields: {}, files: [] }
  let pos = body.indexOf(delim)
  while (pos >= 0) {
    const next = body.indexOf(delim, pos + delim.length)
    if (next < 0) break
    let part = body.subarray(pos + delim.length, next)
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2)
    const headerEnd = part.indexOf("\r\n\r\n")
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString("utf8")
      let data = part.subarray(headerEnd + 4)
      if (data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 2)
      const name = /name="([^"]*)"/.exec(headers)?.[1] ?? ""
      const filename = /filename="([^"]*)"/.exec(headers)?.[1]
      if (filename !== undefined) out.files.push({ name, filename, data })
      else out.fields[name] = data.toString("utf8")
    }
    pos = next
  }
  return out
}

function savePhoto(data, source, hint = "") {
  // Sniff the type: JPEG magic, ISO-BMFF "ftyp" (AVIF — the BLE path compresses
  // to AVIF), else fall back to the hint's extension.
  let ext = "bin"
  if (data[0] === 0xff && data[1] === 0xd8) ext = "jpg"
  else if (data.length > 12 && data.subarray(4, 8).toString() === "ftyp") ext = "avif"
  else if (hint.includes(".")) ext = hint.split(".").pop()
  const file = join(PHOTO_DIR, `photo-${Date.now()}-${source}.${ext}`)
  writeFileSync(file, data)
  const rec = { at: new Date().toISOString(), file, bytes: data.length, source }
  photos.push(rec)
  log(`📷 photo saved: ${file} (${data.length}B via ${source})`)
  pushEvent("photoSaved", rec)
  return rec
}

mgr.on("photoFile", (f) => savePhoto(f.data, "ble", f.fileName))

const mediaServer = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    log(`media rx: ${req.method} ${req.url} (${body.length}B, ${req.headers["content-type"] || "no ct"})`)
    try {
      const parsed = parseMultipart(body, req.headers["content-type"])
      if (parsed?.files.length) {
        for (const f of parsed.files) savePhoto(f.data, "wifi", f.filename || "")
        json(res, 200, { ok: true, received: parsed.files.length, fields: parsed.fields })
        return
      }
      // Raw-body fallback (some paths PUT/POST the image directly).
      if (body.length > 1000 && body[0] === 0xff && body[1] === 0xd8) {
        savePhoto(body, "wifi-raw")
        json(res, 200, { ok: true, received: 1 })
        return
      }
      json(res, 200, { ok: true, received: 0 })
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message || e) })
    }
  })
})
mediaServer.listen(MEDIA_PORT, "0.0.0.0", () => log(`media receiver on 0.0.0.0:${MEDIA_PORT} (lan ${lanIp() ?? "?"})`))

// ---------------------------------------------------------------------------
// Remote-SGC bridge: lets the MentraOS app (Android emulator, no Bluetooth)
// drive the REAL glasses this daemon holds. The app's dev-only RemoteHarness
// driver opens a plain TCP socket (10.0.2.2 -> host) and speaks newline-
// delimited JSON: commands in ({cmd:"text"|"clear"|"mic"|...}), events out
// ({event:"hello"|"status"|"battery"|"gesture"|"imu"} and {event:"audio",
// b64:<LC3>} for the glasses mic). Plain TCP because the bluetooth-sdk module
// has no WebSocket/HTTP client dependency.
// ---------------------------------------------------------------------------
const SGC_PORT = PORT + 3
const sgcClients = new Set()

function sgcSend(sock, obj) {
  try { sock.write(JSON.stringify(obj) + "\n") } catch {}
}
function sgcBroadcast(obj) {
  for (const s of sgcClients) sgcSend(s, obj)
}
mgr.on("audio", ({ data }) => sgcBroadcast({ event: "audio", b64: Buffer.from(data).toString("base64") }))
mgr.on("status", (s) => sgcBroadcast({ event: "battery", level: s?.battery ?? -1, charging: !!s?.charging }))
mgr.on("gesture", (g) => sgcBroadcast({ event: "gesture", gesture: g.gesture }))
mgr.on("imu", (v) => sgcBroadcast({ event: "imu", ...v }))
mgr.on("state", (s) => sgcBroadcast({ event: "status", connected: s.connected, device: s.device, match: s.match }))

async function sgcHandle(sock, msg) {
  const reply = (obj) => sgcSend(sock, { id: msg.id, ...obj })
  try {
    switch (msg.cmd) {
      case "ping": return reply({ ok: true, pong: true })
      case "state": return reply({ ok: true, ...mgr.status() })
      case "text": return reply(await mgr.displayText(String(msg.text ?? " ")))
      case "clear": return reply(await mgr.clear())
      case "mic": return reply(await mgr.setMic(!!msg.enable))
      case "brightness": return reply(await mgr.setBrightness(Number(msg.level ?? 128), !!msg.auto))
      case "headup": return reply(await mgr.setHeadUpAngle(Number(msg.angle ?? 30)))
      case "battery": {
        const info = await mgr.requestInfo()
        if (info?.battery != null) sgcSend(sock, { event: "battery", level: info.battery, charging: !!info.charging })
        return reply({ ok: true, ...info })
      }
      case "imuEnable": return reply(await mgr.setImu(!!msg.enable, Number(msg.freq ?? 100)))
      case "photo": return reply(await mgr.takePhoto(msg.opts || {}))
      default: return reply({ ok: false, error: `unknown cmd ${msg.cmd}` })
    }
  } catch (e) {
    reply({ ok: false, error: String(e?.message || e) })
  }
}

const sgcServer = net.createServer((sock) => {
  sgcClients.add(sock)
  log(`remote-sgc client connected (${sgcClients.size} total)`)
  sock.setNoDelay(true)
  sgcSend(sock, { event: "hello", ...mgr.status() })
  let buf = ""
  sock.on("data", (d) => {
    buf += d.toString("utf8")
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try { void sgcHandle(sock, JSON.parse(line)) } catch {}
    }
  })
  sock.on("close", (hadError) => { sgcClients.delete(sock); log(`remote-sgc client closed (hadError=${hadError})`) })
  sock.on("error", (e) => { sgcClients.delete(sock); log(`remote-sgc client error: ${e?.message}`) })
  sock.setKeepAlive(true, 5000)
})
sgcServer.listen(SGC_PORT, "0.0.0.0", () => log(`remote-sgc bridge on 0.0.0.0:${SGC_PORT}`))
let lastImu = null // IMU is high-rate; keep only the latest sample (exposed via /status)
mgr.on("imu", (v) => { lastImu = v })

// Binary audio fan-out: rebroadcast each glasses LC3 chunk to any connected
// client (the captions bridge). Mirrors G2.kt handleAudioData: cap at 200 bytes,
// align to whole 40-byte LC3 frames, and drop consecutive duplicates (firmware
// repeats the last frame on both arms).
const AUDIO_PORT = PORT + 1
const audioWss = new WebSocketServer({ host: "127.0.0.1", port: AUDIO_PORT })
let lastAudio = null
mgr.on("audio", ({ data }) => {
  let buf = data.length > 200 ? data.subarray(0, 200) : data
  const aligned = Math.floor(buf.length / 40) * 40
  if (aligned < 40) return
  buf = buf.subarray(0, aligned)
  if (lastAudio && buf.equals(lastAudio)) return
  lastAudio = Buffer.from(buf)
  for (const c of audioWss.clients) if (c.readyState === 1) c.send(buf)
})

function body(req) {
  return new Promise((res) => {
    let d = ""
    req.on("data", (c) => (d += c))
    req.on("end", () => { try { res(d ? JSON.parse(d) : {}) } catch { res({}) } })
  })
}
const json = (r, code, obj) => {
  r.writeHead(code, { "Content-Type": "application/json" })
  r.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0]
  try {
    if (req.method === "GET" && url === "/status")
      return json(res, 200, { ...mgr.status(), audioPort: AUDIO_PORT, mediaPort: MEDIA_PORT, lanIp: lanIp(), photos: photos.length, imu: lastImu })
    if (req.method === "GET" && url === "/logs") return json(res, 200, { logs: logs.slice(-80) })
    if (req.method === "POST" && url === "/connect") {
      const b = await body(req)
      log(`connect request: ${b.serial}`)
      const r = await mgr.start(String(b.serial || "G2_"), { waitMs: Number(b.waitMs || 30000) })
      return json(res, 200, { ok: true, ...r })
    }
    if (req.method === "POST" && url === "/text") {
      const b = await body(req)
      return json(res, 200, await mgr.displayText(String(b.text ?? "")))
    }
    if (req.method === "POST" && url === "/clear") return json(res, 200, await mgr.clear())
    if (req.method === "POST" && url === "/mic") {
      const b = await body(req)
      return json(res, 200, await mgr.setMic(!!b.enable))
    }
    if (req.method === "POST" && url === "/brightness") {
      const b = await body(req)
      return json(res, 200, await mgr.setBrightness(Number(b.level), !!b.auto))
    }
    if (req.method === "POST" && url === "/headup") {
      const b = await body(req)
      return json(res, 200, await mgr.setHeadUpAngle(Number(b.angle)))
    }
    if (req.method === "POST" && url === "/image") {
      const b = await body(req)
      const width = Number(b.width ?? 200)
      const height = Number(b.height ?? 100)
      // Use a supplied 4-bit BMP (base64), else generate a demo test pattern.
      const img = b.bmpBase64 ? Buffer.from(b.bmpBase64, "base64") : bmp.encode4BitBmp(bmp.demoImage(width, height))
      return json(res, 200, await mgr.displayImage(img, { x: Number(b.x ?? 188), y: Number(b.y ?? 44), width, height }))
    }
    if (req.method === "POST" && url === "/imu") {
      const b = await body(req)
      return json(res, 200, await mgr.setImu(!!b.enable, Number(b.freq ?? 100)))
    }
    if (req.method === "GET" && url === "/info") {
      return json(res, 200, await mgr.requestInfo())
    }
    if (req.method === "POST" && url === "/photo") {
      const b = (await body(req)) || {}
      // WiFi path: default the webhook to this daemon's media receiver.
      if (b.transferMethod === "wifi" && !b.webhookUrl) {
        const ip = b.host || lanIp()
        if (!ip) return json(res, 400, { ok: false, error: "no LAN IP for webhookUrl" })
        b.webhookUrl = `http://${ip}:${MEDIA_PORT}/photo-upload`
      }
      return json(res, 200, await mgr.takePhoto(b))
    }
    if (req.method === "GET" && url === "/photos") {
      return json(res, 200, { photoDir: PHOTO_DIR, photos: photos.slice(-20) })
    }
    if (req.method === "POST" && url === "/stream/start") {
      const b = (await body(req)) || {}
      const ip = b.host || lanIp()
      const streamUrl = b.streamUrl || (ip ? `rtmp://${ip}:1935/live/harness` : null)
      if (!streamUrl) return json(res, 400, { ok: false, error: "no streamUrl and no LAN IP" })
      return json(res, 200, await mgr.startStream(streamUrl))
    }
    if (req.method === "POST" && url === "/stream/stop") {
      return json(res, 200, await mgr.stopStream())
    }
    if (req.method === "POST" && url === "/live") {
      const b = await body(req)
      return json(res, 200, await mgr.sendLive(b.cmd, b.wakeup !== false))
    }
    if (req.method === "GET" && url === "/liveEvents") {
      return json(res, 200, { events: events.slice(-60) })
    }
    if (req.method === "POST" && url === "/disconnect") return json(res, 200, await mgr.stop())
    if (req.method === "POST" && url === "/shutdown") {
      json(res, 200, { ok: true, bye: true })
      log("shutdown")
      setTimeout(() => process.exit(0), 100)
      return
    }
    json(res, 404, { error: "unknown route" })
  } catch (e) {
    json(res, 500, { ok: false, error: String(e.message || e) })
  }
})

server.listen(PORT, "127.0.0.1", () => {
  try { writeFileSync(PID_FILE, String(process.pid)) } catch {}
  // fresh log on each daemon boot
  try { writeFileSync(LOG_FILE, "") } catch {}
  log(`glasses daemon listening on 127.0.0.1:${PORT} (pid ${process.pid})`)
})

process.on("SIGTERM", () => process.exit(0))
process.on("uncaughtException", (e) => log(`uncaught: ${e.message}`))
