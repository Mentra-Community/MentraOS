// Even Realities G2 protocol — pure encoder, no BLE/IO. Ported 1:1 from the
// repo's own driver: mobile/modules/bluetooth-sdk/.../sgcs/G2.kt
//
// Layers, bottom-up:
//   1. CRC16            (G2.kt calcCRC16)
//   2. Protobuf writer  (G2.kt ProtobufWriter — minimal varint/length-delimited)
//   3. EvenBLE framing  (G2.kt EvenBLETransport.buildPackets — header + CRC, chunked)
//   4. Command builders (G2.kt EvenHubProto / DevSettingsProto)
//
// Kept dependency-free and side-effect-free so it can be checked against known
// byte patterns without glasses (see selftest at the bottom: `node g2.mjs`).

// ---------- 1. CRC16 (matches G2.kt calcCRC16) ----------
export function crc16(data) {
  let crc = 0xffff
  for (const byte of data) {
    const b = byte & 0xff
    crc = ((crc >> 8) | ((crc << 8) & 0xff00)) ^ b
    crc = crc ^ ((crc & 0xff) >> 4)
    crc = crc ^ ((crc << 12) & 0xffff)
    crc = crc ^ (((crc & 0xff) << 5) & 0xffff)
  }
  return crc & 0xffff
}

// ---------- 2. Minimal protobuf writer (matches G2.kt ProtobufWriter) ----------
export class PB {
  constructor() {
    this.b = []
  }
  varint(value) {
    // Non-negative only in our use (cmd ids, magic 0..255, unix seconds < 2^31).
    let v = value >>> 0 === value ? value : value
    if (v < 0) throw new Error("varint: negative not supported in this port")
    while (v > 0x7f) {
      this.b.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    this.b.push(v & 0x7f)
    return this
  }
  int32(field, value) {
    this.varint(field << 3) // wire type 0
    this.varint(value)
    return this
  }
  string(field, str) {
    this.varint((field << 3) | 2) // wire type 2
    const utf8 = Buffer.from(str, "utf8")
    this.varint(utf8.length)
    for (const c of utf8) this.b.push(c)
    return this
  }
  bytes(field, buf) {
    this.varint((field << 3) | 2)
    this.varint(buf.length)
    for (const c of buf) this.b.push(c)
    return this
  }
  message(field, sub) {
    return this.bytes(field, sub)
  }
  bool(field, v) {
    return this.int32(field, v ? 1 : 0)
  }
  buf() {
    return Buffer.from(this.b)
  }
}

// ---------- 3. EvenBLE framing (matches G2.kt EvenBLETransport.buildPackets) ----------
export const G2BLE = {
  HEADER: 0xaa,
  SOURCE_PHONE: 1,
  DEST_GLASSES: 2,
  MAX_PACKET_PAYLOAD: 236,
}

export function buildPackets(syncId, serviceId, payload, reserveFlag = false) {
  const max = G2BLE.MAX_PACKET_PAYLOAD
  const chunks = []
  for (let off = 0; off < payload.length; off += max) {
    chunks.push(payload.subarray(off, Math.min(off + max, payload.length)))
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0))
  // If last chunk is exactly max, append an empty packet so the CRC has somewhere to go.
  if (chunks[chunks.length - 1].length === max) chunks.push(Buffer.alloc(0))

  const totalPackets = chunks.length
  const crc = crc16(payload)
  const packets = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const serialNum = i + 1
    const isLast = serialNum === totalPackets
    const status = reserveFlag ? 0x20 : 0x00
    const payloadLen = chunk.length + (isLast ? 2 : 0)
    const head = Buffer.from([
      G2BLE.HEADER,
      ((G2BLE.DEST_GLASSES << 4) | G2BLE.SOURCE_PHONE) & 0xff, // 0x21
      syncId & 0xff,
      payloadLen & 0xff,
      totalPackets & 0xff,
      serialNum & 0xff,
      serviceId & 0xff,
      status & 0xff,
    ])
    const parts = [head, chunk]
    if (isLast) parts.push(Buffer.from([crc & 0xff, (crc >> 8) & 0xff]))
    packets.push(Buffer.concat(parts))
  }
  return packets
}

// Per-connection sequence counters (matches G2.kt G2SendManager).
export class SendManager {
  constructor() {
    this._sync = 0
    this._magic = 0
  }
  nextSync() {
    const id = this._sync & 0xff
    this._sync = (this._sync + 1) & 0xff
    return id
  }
  nextMagic() {
    const v = this._magic & 0xff
    this._magic = (this._magic + 1) & 0xff
    return v
  }
  packets(serviceId, payload, reserveFlag = false) {
    return buildPackets(this.nextSync(), serviceId, payload, reserveFlag)
  }
}

// ---------- 4a. Service IDs + EvenHub cmd ids (matches G2.kt) ----------
export const ServiceID = {
  DASHBOARD: 0x01,
  EVEN_AI: 0x07,
  G2_SETTING: 0x09,
  GESTURE_CTRL: 0x0d,
  ONBOARDING: 0x10,
  DEVICE_SETTINGS: 0x80,
  EVEN_HUB: 0xe0,
}
export const EvenHubCmd = {
  CREATE_STARTUP_PAGE: 0,
  UPDATE_IMAGE_RAW_DATA: 3,
  UPDATE_TEXT_DATA: 5,
  REBUILD_PAGE: 7,
  SHUTDOWN_PAGE: 9,
  HEARTBEAT: 12,
  AUDIO_CONTROL: 15,
  IMU_CONTROL: 19,
}
const DevCfg = { AUTHENTICATION: 4, PIPE_ROLE_CHANGE: 5, TIME_SYNC: 128, BASE_CONN_HEART_BEAT: 14 }

// ---------- 4b. EvenHub builders ----------
function textContainerProperty({
  x, y, width, height,
  borderWidth = 0, borderColor = 0, borderRadius = 0, paddingLength = 0,
  containerID, containerName = null, isEventCapture = false, content = null,
}) {
  const w = new PB()
  w.int32(1, x).int32(2, y).int32(3, width).int32(4, height)
  w.int32(5, borderWidth).int32(6, borderColor).int32(7, borderRadius).int32(8, paddingLength)
  w.int32(9, containerID)
  if (containerName != null) w.string(10, containerName)
  w.int32(11, isEventCapture ? 1 : 0)
  if (content != null) w.string(12, content)
  return w.buf()
}

function createStartupPageContainer(total, textProps = [], imageProps = []) {
  const w = new PB()
  w.int32(1, total)
  for (const tc of textProps) w.message(3, tc)
  for (const ic of imageProps) w.message(4, ic)
  return w.buf()
}

function evenHubMessage(cmd, subField, subMsg, magic = 0, appId = null) {
  const w = new PB()
  w.int32(1, cmd)
  w.int32(2, magic)
  w.message(subField, subMsg)
  if (appId != null) w.int32(5, appId)
  return w.buf()
}

// CREATE_STARTUP_PAGE carries the text inline (content in the container property),
// so a single create-page renders text — exactly what G2.kt createPageWithContainers does.
export function createPageMessage(textProps, imageProps = [], magic = 0) {
  const total = textProps.length + imageProps.length
  const createMsg = createStartupPageContainer(total, textProps, imageProps)
  return evenHubMessage(EvenHubCmd.CREATE_STARTUP_PAGE, 3, createMsg, magic, null)
}

export function updateTextMessage(containerID, content, magic = 0) {
  const upgrade = new PB()
  upgrade.int32(1, containerID)
  upgrade.int32(3, 0) // contentOffset
  upgrade.int32(4, Buffer.from(content, "utf8").length) // contentLength
  upgrade.string(5, content)
  return evenHubMessage(EvenHubCmd.UPDATE_TEXT_DATA, 9, upgrade.buf(), magic)
}

export function heartbeatMessage(magic = 0) {
  return evenHubMessage(EvenHubCmd.HEARTBEAT, 14, Buffer.alloc(0), magic)
}

export function audioControlMessage(enable, magic = 0) {
  const sub = new PB().int32(1, enable ? 1 : 0).buf()
  return evenHubMessage(EvenHubCmd.AUDIO_CONTROL, 18, sub, magic)
}

// IMU: enable/disable head-orientation reporting. reportFrq is a pacing code
// (100/500/1000), not Hz. Sub-message rides field 20 of the EvenHub ctx.
export function imuControlMessage(enable, reportFrq = 100, magic = 0) {
  const sub = new PB().int32(1, enable ? 1 : 0)
  if (enable) sub.int32(2, reportFrq)
  return evenHubMessage(EvenHubCmd.IMU_CONTROL, 20, sub.buf(), magic)
}

// ---------- Image / bitmap on the lens ----------
// An image container property (geometry + id), used in the page; image ids 10-13.
export function imageContainerProperty({ x, y, width, height, containerID, containerName = null }) {
  const w = new PB().int32(1, x).int32(2, y).int32(3, width).int32(4, height).int32(5, containerID)
  if (containerName != null) w.string(6, containerName)
  return w.buf()
}

// A page carrying one image container (geometry); the raw pixels follow via
// updateImageMessage fragments.
export function imagePageMessage(imageProp, magic = 0) {
  return createPageMessage([], [imageProp], magic)
}

// One fragment of a 4-bit BMP. compressMode 0 = uncompressed.
export function updateImageMessage(containerID, name, sessionId, totalSize, fragIndex, fragData, magic = 0) {
  const upd = new PB().int32(1, containerID)
  if (name) upd.string(2, name)
  upd
    .int32(3, sessionId)
    .int32(4, totalSize)
    .int32(5, 0)
    .int32(6, fragIndex)
    .int32(7, fragData.length)
    .bytes(8, fragData)
  return evenHubMessage(EvenHubCmd.UPDATE_IMAGE_RAW_DATA, 5, upd.buf(), magic)
}

// The default full-screen text container the app uses (G2.kt defaultText* + pool id 1).
export function defaultTextPage(text, magic = 0) {
  const prop = textContainerProperty({
    x: 0, y: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 4,
    containerID: 1, containerName: "text-1", isEventCapture: true,
    content: text.length === 0 ? " " : text,
  })
  return createPageMessage([prop], [], magic)
}

// ---------- 4c. DevSettings (auth/time/heartbeat) builders ----------
export function authCmd(magic) {
  const w = new PB()
  w.int32(1, DevCfg.AUTHENTICATION).int32(2, magic)
  const auth = new PB().bool(1, true).int32(2, 4) // secAuth=true, phoneType=PHONE_ANDROID(4)
  w.message(3, auth.buf())
  return w.buf()
}
export function pipeRoleChange(magic) {
  const w = new PB()
  w.int32(1, DevCfg.PIPE_ROLE_CHANGE).int32(2, magic)
  const role = new PB().int32(1, 1) // asCmdRole = RIGHT(1)
  w.message(4, role.buf())
  return w.buf()
}
export function timeSync(magic, nowMs, tzOffsetSec) {
  const w = new PB()
  w.int32(1, DevCfg.TIME_SYNC).int32(2, magic)
  const nowSec = Math.floor(nowMs / 1000)
  const ts = new PB().int32(1, (nowSec + tzOffsetSec) >>> 0)
  w.message(128, ts.buf())
  return w.buf()
}
export function baseHeartbeat(magic) {
  const w = new PB()
  w.int32(1, DevCfg.BASE_CONN_HEART_BEAT).int32(2, magic)
  w.message(13, Buffer.alloc(0)) // BaseConnHeartBeat: empty
  return w.buf()
}

// ---------- 4d. G2Setting builders (brightness, head-up angle) ----------
const G2SettingCmd = { DEVICE_RECEIVE_INFO: 1 }

// level 0..255, autoAdjust toggles auto-brightness. Service 0x09.
export function setBrightnessMessage(level, autoAdjust, magic = 0) {
  const brightness = new PB().int32(1, autoAdjust ? 1 : 0).int32(2, level).buf()
  const info = new PB().message(1, brightness).buf()
  return new PB().int32(1, G2SettingCmd.DEVICE_RECEIVE_INFO).int32(2, magic).message(3, info).buf()
}

// vertical position of the heads-up display.
export function setHeadUpAngleMessage(angle, magic = 0) {
  const headUp = new PB().int32(2, angle).buf()
  const info = new PB().message(4, headUp).buf()
  return new PB().int32(1, G2SettingCmd.DEVICE_RECEIVE_INFO).int32(2, magic).message(3, info).buf()
}

// ---------- 5. Receive side (decode notifications from the glasses) ----------

// Even mfg-data carries the fixed factory serial as ASCII; pull the longest
// printable-ASCII run (handles both G1 side-flag and G2 company-id layouts).
export function decodeSerial(buf) {
  if (!buf) return null
  let best = "", cur = ""
  for (const b of buf) {
    if (b >= 0x30 && b <= 0x5a) cur += String.fromCharCode(b)
    else { if (cur.length > best.length) best = cur; cur = "" }
  }
  if (cur.length > best.length) best = cur
  return best.length >= 6 ? best : null
}

// Parse a notify packet's framing (glasses -> phone). Returns null if not an
// EvenBLE frame. `cmd` is the first protobuf int32 field (the command/event id).
export function parseNotify(buf) {
  if (buf.length < 8 || buf[0] !== G2BLE.HEADER) return null
  const payloadLen = buf[3]
  const serviceId = buf[6]
  const isLast = buf[5] === buf[4]
  const end = Math.min(8 + payloadLen - (isLast ? 2 : 0), buf.length)
  const payload = buf.subarray(8, Math.max(8, end))
  // read first field (tag + varint) to recover the cmd id, best-effort
  let cmd = null
  if (payload.length >= 2 && (payload[0] & 0x07) === 0) {
    let v = 0, shift = 0, i = 1
    while (i < payload.length) {
      v |= (payload[i] & 0x7f) << shift
      if ((payload[i] & 0x80) === 0) break
      shift += 7; i++
    }
    cmd = v
  }
  return { serviceId, syncId: buf[2], serialNum: buf[5], totalPackets: buf[4], cmd, payload }
}

// Generic protobuf field reader: returns { field -> number (varint) | Buffer
// (length-delimited) | Buffer (32-bit) }. Enough to walk the G2 responses.
function readVarintAt(buf, i) {
  let v = 0, shift = 0
  while (i < buf.length) {
    const b = buf[i++]
    v += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [v, i]
}
export function parseFields(buf) {
  const out = {}
  let i = 0
  while (i < buf.length) {
    let tag
    ;[tag, i] = readVarintAt(buf, i)
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      ;[out[field], i] = readVarintAt(buf, i)
    } else if (wire === 2) {
      let len
      ;[len, i] = readVarintAt(buf, i)
      out[field] = buf.subarray(i, i + len)
      i += len
    } else if (wire === 5) {
      out[field] = buf.subarray(i, i + 4)
      i += 4
    } else if (wire === 1) {
      out[field] = buf.subarray(i, i + 8)
      i += 8
    } else break
  }
  return out
}

const GESTURES = { 0: "tap", 1: "swipe_up", 2: "swipe_down", 3: "double_tap", 4: "foreground_enter", 5: "foreground_exit", 7: "system_exit" }

// Decode a reassembled G2 notify payload into a semantic event: IMU, gesture,
// or device status (battery/charging/firmware). Returns null if not recognized.
export function decodeG2Event(serviceId, payload) {
  const f = parseFields(payload)
  const cmd = f[1]
  // EvenHub OS_NOTIFY_EVENT_TO_APP (cmd 2): taps, swipes, and IMU reports.
  if (serviceId === ServiceID.EVEN_HUB && cmd === 2) {
    const dev = f[13]
    if (!dev || !(dev instanceof Uint8Array)) return null
    const sys = parseFields(dev)[3]
    if (!sys || !(sys instanceof Uint8Array)) return null
    const sf = parseFields(sys)
    const eventType = sf[1]
    if (eventType === 8 && sf[3] instanceof Uint8Array) {
      const imf = parseFields(sf[3])
      const flt = (b) => (b instanceof Uint8Array && b.length === 4 ? Buffer.from(b).readFloatLE(0) : null)
      return { type: "imu", x: flt(imf[1]), y: flt(imf[2]), z: flt(imf[3]) }
    }
    return { type: "gesture", gesture: GESTURES[eventType] ?? `event_${eventType}`, eventType }
  }
  // G2Setting response: battery %, charging, firmware (nested in field 4).
  if (serviceId === ServiceID.G2_SETTING && (cmd === 2 || cmd === 3)) {
    const info = f[4]
    if (!info || !(info instanceof Uint8Array)) return null
    const inf = parseFields(info)
    const out = { type: "status" }
    if (typeof inf[12] === "number") out.battery = inf[12]
    if (typeof inf[13] === "number") out.charging = inf[13] !== 0
    if (inf[5] instanceof Uint8Array) out.leftFirmware = Buffer.from(inf[5]).toString("utf8")
    if (inf[6] instanceof Uint8Array) out.rightFirmware = Buffer.from(inf[6]).toString("utf8")
    return out.battery != null || out.leftFirmware || out.rightFirmware ? out : null
  }
  return null
}

// G2Setting: request basic info (battery %, firmware). Response decoded above.
export function requestInfoMessage(magic = 0) {
  const req = new PB().int32(1, 1).buf() // settingInfoType = APP_REQUIRE_BASIC_SETTING
  return new PB().int32(1, 2).int32(2, magic).message(4, req).buf() // cmd DEVICE_RECEIVE_REQUEST
}

// ---------- selftest: `node g2.mjs` — checks framing/CRC shape without hardware ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const hex = (b) => Buffer.from(b).toString("hex")
  const page = defaultTextPage("Hi", 0)
  const pkts = buildPackets(0, ServiceID.EVEN_HUB, page, true)
  console.log("defaultTextPage('Hi') payload:", hex(page))
  console.log("packets:", pkts.length)
  for (const p of pkts) console.log("  ", hex(p))
  // Structural assertions
  const p0 = pkts[0]
  console.assert(p0[0] === 0xaa, "header 0xAA")
  console.assert(p0[1] === 0x21, "dest/src 0x21")
  console.assert(p0[6] === 0xe0, "serviceId EVEN_HUB")
  console.assert(p0[7] === 0x20, "status reserveFlag bit5")
  const crc = crc16(page)
  console.assert(p0[p0.length - 2] === (crc & 0xff) && p0[p0.length - 1] === ((crc >> 8) & 0xff), "trailing CRC16")
  console.log("auth:", hex(authCmd(0)), "| pipeRole:", hex(pipeRoleChange(1)), "| hb:", hex(heartbeatMessage(2)))
  console.log("selftest OK")
}
