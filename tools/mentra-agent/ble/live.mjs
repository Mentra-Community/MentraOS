// Mentra Live protocol — pure encoder/decoder, no BLE/IO. Ported from the app's
// driver: mobile/modules/bluetooth-sdk/.../sgcs/MentraLive.java + K900ProtocolUtils.java
//
// Mentra Live is a CAMERA glasses (no display): photo, mic, battery, buttons.
// Single BLE device (not L/R). Control is JSON wrapped in the K900 frame:
//   ## 0x30 [len LE16] { "C": "<json>", "W": 1? } $$
// where the inner C string is the actual command/response JSON. The glasses also
// send K900 device commands shaped { "C": "sr_hrt", "B": {...} } (battery/boot/taps).

export const LiveBLE = {
  SERVICE: "00004860",
  WRITE: "71ff", // phone -> glasses JSON commands
  NOTIFY: "70ff", // glasses -> phone JSON responses
  AUDIO: "6e400002", // LC3 mic (central receives): 0xF1 + seq + 40-byte frame
}

const START = 0x23 // '#'
const END = 0x24 // '$'
const TYPE_STRING = 0x30

// ---------- frame a JSON command for the wire ----------
export function packCommand(obj, wakeup = true) {
  const inner = JSON.stringify(obj)
  const wrap = wakeup ? { C: inner, W: 1 } : { C: inner }
  const data = Buffer.from(JSON.stringify(wrap), "utf8")
  const len = data.length
  return Buffer.concat([
    Buffer.from([START, START, TYPE_STRING, len & 0xff, (len >> 8) & 0xff]), // little-endian length
    data,
    Buffer.from([END, END]),
  ])
}

// ---------- extract complete K900 frames from a rolling rx buffer ----------
// Returns { frames: [innerBuffer...], rest: leftoverBuffer }. Handles frames
// split across BLE notifications and concatenated frames.
export function extractFrames(buf) {
  const frames = []
  let i = 0
  while (i + 5 <= buf.length) {
    if (buf[i] !== START || buf[i + 1] !== START) {
      i++
      continue
    }
    // Incoming frames (glasses->phone) use BIG-endian length; the phone SEND path
    // uses little-endian (K900 has two packers). Confirmed against real DA08 bytes.
    const len = (buf[i + 3] << 8) | buf[i + 4]
    const end = i + 5 + len
    if (end + 2 > buf.length) break // incomplete; wait for more
    frames.push(buf.subarray(i + 5, end)) // the C-wrapped JSON bytes
    i = end + 2 // skip the trailing $$
  }
  return { frames, rest: buf.subarray(i) }
}

// ---------- decode one inner frame (the C-wrapped JSON) into an event ----------
export function decodeFrame(innerBuf) {
  let obj
  try {
    obj = JSON.parse(innerBuf.toString("utf8"))
  } catch {
    return null
  }
  // Unwrap the C field.
  let msg = obj
  let k900 = null
  if (obj.C !== undefined) {
    if (typeof obj.C === "string" && obj.C.trimStart().startsWith("{")) {
      try { msg = JSON.parse(obj.C) } catch { return null }
    } else {
      k900 = obj.C // a device command name like "sr_hrt"
      msg = { k900, body: obj.B }
    }
  }
  return normalize(msg, k900)
}

function normalize(msg, k900) {
  // K900 device commands (battery/boot/taps).
  if (k900 || msg.k900) {
    const name = k900 || msg.k900
    const b = msg.body || {}
    if (name === "sr_hrt") return { type: "status", battery: b.pt, charging: b.charg === 1, ready: b.ready === 1, raw: name }
    if (name === "sr_batv") return { type: "status", battery: b.pt, voltage: b.vt, raw: name }
    if (name === "sr_tpevt") {
      const g = { 0: "tap", 1: "double_tap", 2: "triple_tap", 3: "long_press", 4: "swipe_fwd", 5: "swipe_back" }[b.type]
      return { type: "gesture", gesture: g ?? `tp_${b.type}`, raw: name }
    }
    return { type: "k900", name, body: b }
  }
  // Standard JSON messages.
  switch (msg.type) {
    case "battery_status":
      return { type: "status", battery: msg.percent, charging: !!msg.charging }
    case "pong":
      return { type: "pong" }
    case "button_press":
      return { type: "gesture", gesture: `button_${msg.pressType ?? "press"}`, buttonId: msg.buttonId }
    case "wifi_status":
      return { type: "wifi", connected: !!msg.connected, ssid: msg.ssid, ip: msg.local_ip }
    case "photo_response":
    case "ble_photo_complete":
      return {
        type: "photo",
        requestId: msg.requestId,
        success: msg.success !== false,
        state: msg.state,
        error: msg.errorMessage ?? msg.error,
        bleImgId: msg.bleImgId,
      }
    case "token_status":
      return { type: "token", success: !!msg.success }
    case "imu_stream_response": {
      const readings = msg.readings || msg.data?.readings // some firmware nests under data
      const r = Array.isArray(readings) ? readings[readings.length - 1] : null
      return r ? { type: "imu", accel: r.accel, gyro: r.gyro, euler: r.euler, quat: r.quat } : { type: "imu" }
    }
    case "version_response":
    case "version_info":
      return { type: "version", ...msg }
    default:
      return msg.type ? { type: msg.type, ...msg } : null
  }
}

// ---------- command builders ----------
export const cmd = {
  phoneReady: () => ({ type: "phone_ready", timestamp: 0 }),
  ping: () => ({ type: "ping" }),
  requestVersion: () => ({ type: "request_version" }),
  requestBattery: () => ({ type: "request_battery_state" }),
  requestWifiStatus: () => ({ type: "request_wifi_status" }),
  keepAwake: () => ({ type: "keep_awake" }),
  takePhoto: (requestId, opts = {}) => {
    const msg = {
      type: "take_photo",
      requestId,
      appId: opts.appId || "com.mentra.harness",
      size: opts.size || "medium",
      transferMethod: opts.transferMethod || "ble",
      save: opts.save !== false,
      flash: !!opts.flash,
      sound: opts.sound !== false,
    }
    // WiFi path: glasses POST the JPEG (multipart) to this URL.
    if (opts.webhookUrl) msg.webhookUrl = opts.webhookUrl
    if (opts.authToken) msg.authToken = opts.authToken
    // BLE path: glasses send K900 file packets named <bleImgId>.<ext> on 72FF.
    if (opts.bleImgId) msg.bleImgId = opts.bleImgId
    return msg
  },
  // RTMP/SRT/WHIP streaming (asg StreamCommandHandler: start_stream/stop_stream).
  startStream: (streamUrl) => ({ type: "start_stream", streamUrl }),
  stopStream: () => ({ type: "stop_stream" }),
  getStreamStatus: () => ({ type: "get_stream_status" }),
  keepStreamAlive: () => ({ type: "keep_stream_alive" }),
  // Confirmation the phone sends after a BLE file transfer (success or retry-request).
  transferComplete: (fileName, success) => ({ type: "transfer_complete", fileName, success, timestamp: 0 }),
}

// ---------- K900 file packets (BLE photo/file transfer on char 72FF) ----------
// Layout (all big-endian): ## fileType(1) packSize(2) packIndex(2) fileSize(4)
//                          fileName(16, NUL-padded) flags(2) data(packSize) verify(1) $$
// verify = sum(data) & 0xFF. Ported from K900ProtocolUtils.extractFilePacket.
export function parseFilePacket(buf) {
  if (!buf || buf.length < 31 || buf[0] !== START || buf[1] !== START) return null
  let pos = 2
  const fileType = buf[pos]; pos += 1
  const packSize = (buf[pos] << 8) | buf[pos + 1]; pos += 2
  const packIndex = (buf[pos] << 8) | buf[pos + 1]; pos += 2
  const fileSize = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4
  let nameEnd = pos
  while (nameEnd < pos + 16 && buf[nameEnd] !== 0) nameEnd++
  const fileName = buf.subarray(pos, nameEnd).toString("utf8"); pos += 16
  const flags = (buf[pos] << 8) | buf[pos + 1]; pos += 2
  if (buf.length < pos + packSize + 1 + 2) return { incomplete: true, need: pos + packSize + 3 }
  const data = buf.subarray(pos, pos + packSize); pos += packSize
  const verify = buf[pos]; pos += 1
  if (buf[pos] !== END || buf[pos + 1] !== END) return null
  let sum = 0
  for (const b of data) sum = (sum + b) & 0xffffffff
  return {
    fileType, packSize, packIndex, fileSize, fileName, flags,
    data: Buffer.from(data),
    valid: (sum & 0xff) === verify,
    consumed: pos + 2,
  }
}

// ---------- mic audio (incoming on the LC3 char): 0xF1 + seq + 40-byte frames ----------
export function decodeAudio(buf) {
  if (!buf || buf.length < 2 || buf[0] !== 0xf1) return null
  return { seq: buf[1], lc3: buf.subarray(2) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hex = (b) => Buffer.from(b).toString("hex")
  const pkt = packCommand(cmd.phoneReady(), true)
  console.log("phone_ready frame:", hex(pkt))
  const { frames } = extractFrames(pkt)
  console.log("round-trip decode:", JSON.stringify(decodeFrame(frames[0])))
  // simulate a real glasses battery heartbeat frame (inner is the C-wrapped K900 cmd)
  const inner = Buffer.from(JSON.stringify({ C: "sr_hrt", B: { pt: 84, ready: 1, charg: 0 } }), "utf8")
  const hrt = Buffer.concat([
    Buffer.from([0x23, 0x23, 0x30, inner.length & 0xff, (inner.length >> 8) & 0xff]),
    inner,
    Buffer.from([0x24, 0x24]),
  ])
  console.log("sr_hrt decode:", JSON.stringify(decodeFrame(extractFrames(hrt).frames[0])))
  console.log("selftest OK")
}
