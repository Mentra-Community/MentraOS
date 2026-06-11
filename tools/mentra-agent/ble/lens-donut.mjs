// lens-donut: the classic spinning ASCII torus on the G2 (smooth, coherent
// frames — single-arm updates keep both eyes hardware-synced).
// Run: node lens-donut.mjs [fps] [cols] [rows]
const fps = Number(process.argv[2] || 15), W = Number(process.argv[3] || 30), H = Number(process.argv[4] || 7)
const post = async (p, body) => (await fetch("http://127.0.0.1:8799" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LUM = ".,-~:;=!*#$@"
let A = 0, B = 0
function frame() {
  const z = new Float32Array(W * H)
  const out = Array(W * H).fill(" ")
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B)
  for (let j = 0; j < 6.28; j += 0.07) {
    const ct = Math.cos(j), st = Math.sin(j)
    for (let i = 0; i < 6.28; i += 0.02) {
      const sp = Math.sin(i), cp = Math.cos(i)
      const h = ct + 2 // R2 + R1*cos(theta)
      const D = 1 / (sp * h * sA + st * cA + 5)
      const t = sp * h * cA - st * sA
      const x = Math.floor(W / 2 + (W / 3.2) * D * (cp * h * cB - t * sB))
      const y = Math.floor(H / 2 + (H / 2.2) * D * (cp * h * sB + t * cB))
      const o = x + W * y
      const N = Math.floor(8 * ((st * sA - sp * ct * cA) * cB - sp * ct * sA - st * cA - cp * ct * sB))
      if (y >= 0 && y < H && x >= 0 && x < W && D > z[o]) {
        z[o] = D
        out[o] = LUM[Math.max(0, Math.min(LUM.length - 1, N))]
      }
    }
  }
  let s = ""
  for (let r = 0; r < H; r++) s += out.slice(r * W, (r + 1) * W).join("") + (r < H - 1 ? "\n" : "")
  return s
}
await post("/text", { text: "donut..." }); await sleep(800)
for (;;) {
  await post("/text", { text: frame(), arms: "right" }).catch(() => {})
  A += 0.09; B += 0.04
  await sleep(1000 / fps)
}
