// lens-clock: persistent analog clock on the G2, rendered as rapid partial
// bitmap updates of a single 96x96 container (~3 fps, ack-gated).
import * as bmp from "./bmp.mjs"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = async (p, body) => (await fetch("http://127.0.0.1:8799" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()

const S = 88, CX = S >> 1, CY = S >> 1, R = S / 2 - 4

function hand(f, angle, len, gray) {
  bmp.line(f, CX, CY, Math.round(CX + len * Math.sin(angle)), Math.round(CY - len * Math.cos(angle)), gray)
}
function clockFrame() {
  const f = bmp.frame(S, S, 0)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI
    const x1 = CX + (R - 4) * Math.sin(a), y1 = CY - (R - 4) * Math.cos(a)
    const x2 = CX + R * Math.sin(a), y2 = CY - R * Math.cos(a)
    bmp.line(f, Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), i % 3 === 0 ? 255 : 120)
  }
  const now = new Date()
  const sec = now.getSeconds() + now.getMilliseconds() / 1000
  const min = now.getMinutes() + sec / 60
  const hr = (now.getHours() % 12) + min / 60
  hand(f, (hr / 12) * 2 * Math.PI, R * 0.5, 255)
  hand(f, (min / 60) * 2 * Math.PI, R * 0.75, 200)
  hand(f, (sec / 60) * 2 * Math.PI, R * 0.9, 140)
  bmp.disc(f, CX, CY, 2, 255)
  return f
}

console.log("setting up clock container...")
await post("/text", { text: "clock" }); await sleep(800)
const setup = await post("/image", { imageOnly: true, x: (576 - S) >> 1, y: (288 - S) >> 1, width: S, height: S,
  bmpBase64: Buffer.from(bmp.encode4BitBmp(clockFrame())).toString("base64") })
console.log("setup:", JSON.stringify(setup))
if (!setup.ok) process.exit(1)
await sleep(400)
let fails = 0
for (;;) {
  const r = await post("/imageUpdate", { id: 1, width: S, height: S, gapMs: 8,
    grayBase64: Buffer.from(clockFrame().data).toString("base64") }).catch(() => ({ ok: false }))
  if (!r.ok) { if (++fails > 10) { console.log("too many failures, exiting"); process.exit(1) } await sleep(2000) }
  else fails = 0
}
