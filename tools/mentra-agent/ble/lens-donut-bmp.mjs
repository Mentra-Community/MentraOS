// lens-donut-bmp: spinning shaded torus rendered as 48x48 bitmap partial
// updates (~8fps, Bayer dither for stable patterns, right-arm-only for sync).
import * as bmp from "./bmp.mjs"
import { existsSync } from "node:fs"
const post = async (p, body) => (await fetch("http://127.0.0.1:8799" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = 48
let A = 0, B = 0
function donutFrame() {
  const z = new Float32Array(S * S)
  const lum = new Float32Array(S * S)
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B)
  for (let j = 0; j < 6.28; j += 0.05) {
    const ct = Math.cos(j), st = Math.sin(j)
    for (let i = 0; i < 6.28; i += 0.015) {
      const sp = Math.sin(i), cp = Math.cos(i)
      const h = ct + 2
      const D = 1 / (sp * h * sA + st * cA + 5)
      const t = sp * h * cA - st * sA
      const x = Math.floor(S / 2 + S * 0.125 * D * 5 * (cp * h * cB - t * sB))
      const y = Math.floor(S / 2 + S * 0.125 * D * 5 * (cp * h * sB + t * cB))
      if (x < 0 || x >= S || y < 0 || y >= S) continue
      const o = y * S + x
      if (D > z[o]) {
        z[o] = D
        const N = (st * sA - sp * ct * cA) * cB - sp * ct * sA - st * cA - cp * ct * sB
        lum[o] = Math.max(0.1, N)
      }
    }
  }
  const f = bmp.frame(S, S, 0)
  for (let i = 0; i < S * S; i++) f.data[i] = Math.min(255, Math.round(lum[i] * 180))
  return bmp.ditherBayer(f)
}
// page = event-capture text (id 1) + donut container (id 2): text and the
// animation coexist; update text any time via POST /text.
const CW = 120, CH = 24 // counter strip (own fixed-width digits, pixel-stable)
const setup = await post("/imagePage", { text: "bitmap counter + donut:",
  tiles: [
    { id: 2, x: (576 - S) >> 1, y: 140, width: S, height: S },
    { id: 3, x: (576 - CW) >> 1, y: 70, width: CW, height: CH },
  ] })
console.log("setup:", JSON.stringify(setup))
if (!setup.ok) process.exit(1)
await sleep(300)
const FONT = {
  "0":["111","101","101","101","111"],"1":["010","110","010","010","111"],
  "2":["111","001","111","100","111"],"3":["111","001","111","001","111"],
  "4":["101","101","111","001","001"],"5":["111","100","111","001","111"],
  "6":["111","100","111","101","111"],"7":["111","001","010","010","010"],
  "8":["111","101","111","101","111"],"9":["111","101","111","001","111"],
}
function counterFrame(n) {
  const f = bmp.frame(CW, CH, 0)
  const str = String(n)
  const gw = 12 + 4, scale = 4
  let x0 = Math.max(0, (CW - str.length * gw) >> 1)
  for (const ch of str) {
    const rows = FONT[ch]
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (rows[r][c] === "1") bmp.fillRect(f, x0 + c * scale, 2 + r * scale, scale, scale, 255)
    }
    x0 += gw
  }
  return f
}
let count = 0
let fails = 0
for (;;) {
  const paused = existsSync("/tmp/donut-pause")
  if (!paused) {
    const r = await post("/imageUpdate", { id: 2, width: S, height: S, gapMs: 8, arms: "right", ackGate: false,
      grayBase64: Buffer.from(donutFrame().data).toString("base64") }).catch(() => ({ ok: false }))
    if (!r.ok && ++fails > 20) process.exit(1)
    if (r.ok) fails = 0
  }
  await post("/imageUpdate", { id: 3, width: CW, height: CH, gapMs: 8, arms: "right", ackGate: false,
    grayBase64: Buffer.from(counterFrame(count).data).toString("base64") }).catch(() => {})
  count++
  if (!paused) { A += 0.14; B += 0.06 }
  await sleep(40)
}
