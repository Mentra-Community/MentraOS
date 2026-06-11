// Even Realities G1 protocol — pure encoder/decoder, no BLE/IO. Ported from the
// app's driver: mobile/modules/bluetooth-sdk/.../sgcs/G1.java
//
// G1 is much simpler than G2: a Nordic UART service with single-byte opcodes and
// no protobuf/framing. Commands are raw byte arrays written to the TX char; the
// glasses notify back on the RX char with opcode-prefixed packets.

export const G1BLE = {
  SERVICE: "6e400001b5a3f393e0a9e50e24dcca9e",
  WRITE: "6e400002", // TX (phone -> glasses)
  NOTIFY: "6e400003", // RX (glasses -> phone)
}

// Per-connection rolling counters (text seq, heartbeat seq).
export class G1Seq {
  constructor() {
    this.text = 0
    this.hb = 0
  }
  nextText() {
    const v = this.text & 0xff
    this.text = (this.text + 1) & 0xff
    return v
  }
  nextHb() {
    const v = this.hb & 0xff
    this.hb = (this.hb + 1) & 0xff
    return v
  }
}

// ---------- init / keepalive ----------
// Commands sent right after both arms connect (see G1.java init sequence).
export const INIT = {
  firmware: Buffer.from([0x6e, 0x74]),
  init: Buffer.from([0x4d, 0xfb]), // left only
  wearOff: Buffer.from([0x27, 0x00]),
  silentOff: Buffer.from([0x03, 0x0a]),
}
export function batteryQuery() {
  return Buffer.from([0x2c, 0x01]) // 0x01 = Android-style request
}
export function heartbeat(seq) {
  // 0x25 len=6 seq 0x00 0x04 seq
  return Buffer.from([0x25, 0x06, seq & 0xff, 0x00, 0x04, seq & 0xff])
}
export function exitToHome() {
  return Buffer.from([0x18])
}

// ---------- display text ----------
// 0x4E seq total idx status(0x71) 00 00 00 01 <utf8...>, chunked at 176 bytes.
export function textPackets(text, seq) {
  const utf8 = Buffer.from(text.length ? text : " ", "utf8")
  const MAX = 176
  const chunks = []
  for (let off = 0; off < utf8.length; off += MAX) chunks.push(utf8.subarray(off, off + MAX))
  if (chunks.length === 0) chunks.push(Buffer.alloc(0))
  const total = chunks.length
  return chunks.map((chunk, i) =>
    Buffer.concat([Buffer.from([0x4e, seq & 0xff, total, i, 0x71, 0x00, 0x00, 0x00, 0x01]), chunk]),
  )
}

// ---------- brightness / settings ----------
// 0x01 level(0-63) auto(0/1). Accepts 0-255 and maps to 0-63 like the CLI.
export function brightness(level0to255, auto) {
  const v = Math.max(0, Math.min(63, Math.round((level0to255 / 255) * 63)))
  return Buffer.from([0x01, v, auto ? 0x01 : 0x00])
}
export function headUpAngle(angle) {
  return Buffer.from([0x0b, Math.max(0, Math.min(60, angle)), 0x01])
}

// ---------- microphone ----------
export function micControl(enable) {
  return Buffer.from([0x0e, enable ? 0x01 : 0x00])
}

// ---------- bitmap (0x15 chunks + 0x20 0x0D 0x0E end + 0x16 CRC32) ----------
const GLASSES_ADDR = Buffer.from([0x00, 0x1c, 0x00, 0x00])
function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
// bmpInverted = the 1-bit BMP bytes (already inverted per G1.java). Returns the
// ordered list of packets to write: chunks, then end, then CRC.
export function bitmapPackets(bmpInverted) {
  const packets = []
  let i = 0
  for (let off = 0; off < bmpInverted.length; ) {
    if (i === 0) {
      const payload = bmpInverted.subarray(off, off + 190)
      packets.push(Buffer.concat([Buffer.from([0x15, i & 0xff]), GLASSES_ADDR, payload]))
      off += payload.length
    } else {
      const payload = bmpInverted.subarray(off, off + 192)
      packets.push(Buffer.concat([Buffer.from([0x15, i & 0xff]), payload]))
      off += payload.length
    }
    i++
  }
  packets.push(Buffer.from([0x20, 0x0d, 0x0e])) // end
  const crc = crc32(Buffer.concat([GLASSES_ADDR, bmpInverted]))
  packets.push(Buffer.from([0x16, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]))
  return packets
}

// ---------- decode notifications (glasses -> phone) ----------
export function decodeG1(buf) {
  if (!buf || buf.length === 0) return null
  const op = buf[0]
  if (op === 0x2c && buf.length >= 3 && buf[1] === 0x66) return { type: "status", battery: buf[2] }
  if (op === 0x25) return { type: "heartbeat" }
  if (op === 0x4e) return { type: "text_ack", ok: buf[1] === 0xc9 }
  if (op === 0xf5) {
    const m = { 0x02: "head_up", 0x03: "head_down", 0x08: "case_open", 0x0b: "case_close" }[buf[1]]
    if (m) return { type: m.startsWith("case") ? "case" : "gesture", gesture: m }
  }
  if (op === 0xf1) return { type: "audio", seq: buf[1], lc3: buf.subarray(2) } // 20-byte LC3 frames
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hex = (b) => Buffer.from(b).toString("hex")
  const seq = new G1Seq()
  console.log("text 'Hi':", textPackets("Hi", seq.nextText()).map(hex))
  console.log("brightness 50%:", hex(brightness(128, true)))
  console.log("mic on:", hex(micControl(true)), "| battery query:", hex(batteryQuery()))
  console.log("heartbeat:", hex(heartbeat(seq.nextHb())))
  console.log("decode battery 2c6655:", JSON.stringify(decodeG1(Buffer.from([0x2c, 0x66, 0x55]))))
  console.log("selftest OK")
}
