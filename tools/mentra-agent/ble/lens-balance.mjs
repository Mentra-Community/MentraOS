// lens-balance: tilt your head shoulder-to-shoulder to roll a ball along a
// trough on the G2 lens. IMU (gravity y) -> physics -> dirty-rect bitmap
// updates (only the tile containing the ball repaints; ~7fps single-tile).
import * as bmp from "./bmp.mjs"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = async (p, body) => (await fetch("http://127.0.0.1:8799" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()
const get = async (p) => (await fetch("http://127.0.0.1:8799" + p)).json()

const TILE_W = 60, TILE_H = 40, TILES = 4, W = TILE_W * TILES // 240x40 trough
const X0 = (576 - W) >> 1, Y0 = 150
const R = 9

// page: event-capture text (id 1) + 4 trough tiles (ids 2..5)
console.log("setting up game page...")
await post("/text", { text: "BALL BALANCE\ntilt head shoulder to shoulder" })
await sleep(900)
// declare all 4 tiles in one rebuild (image ids 2..5; id 1 = text)
// use the tiled-rebuild trick via raw /image calls: first declare via a custom rebuild
const props = []
const tileBmp = (ball) => { // ball = {x within trough px, present}
  const tiles = []
  for (let t = 0; t < TILES; t++) {
    const f = bmp.frame(TILE_W, TILE_H, 0)
    bmp.fillRect(f, 0, TILE_H - 3, TILE_W, 3, 150) // trough floor
    if (t === 0) bmp.fillRect(f, 0, 8, 3, TILE_H - 8, 200) // left wall
    if (t === TILES - 1) bmp.fillRect(f, TILE_W - 3, 8, 3, TILE_H - 8, 200) // right wall
    // center target notch
    const cxAbs = W / 2
    if (cxAbs >= t * TILE_W && cxAbs < (t + 1) * TILE_W) {
      bmp.fillRect(f, Math.round(cxAbs - t * TILE_W) - 6, TILE_H - 6, 12, 3, 80)
    }
    if (ball && ball.x >= t * TILE_W - R && ball.x < (t + 1) * TILE_W + R) {
      bmp.disc(f, Math.round(ball.x - t * TILE_W), TILE_H - 3 - R, R, 255)
    }
    tiles.push(f)
  }
  return tiles
}

// Setup: declare containers using manager's tiled path semantics via /image with
// per-tile geometry — but we need ONE rebuild with all 4 + text. Use a setup
// trick: hit /image (label path) for tile id 2 only declares one... so instead
// drive the rebuild through a single displayImageTiled-style call is wrong too.
// Simplest reliable path: use 4 sequential /image calls each rebuilding ALL
// containers is not supported by the daemon API -> so: use /image once with
// label (text id1 + img id2), then we POST /imageUpdate to ids 3..5 will fail.
// => add tiles via the tiled endpoint? It rebuilds image-only (kills text).
// Pragmatic: tiled endpoint with 4 strips, NO text (IMU works? event capture
// needed...). Test showed IMU needs event-capture. So: do a manual rebuild via
// a tiny inline daemon helper: /image with extraTiles param would be cleanest,
// but to avoid daemon edits we exploit: /image label path declares text+img(id2)
// -- then ids 3,4,5 in three more /image calls each REPLACE the container set.
// NOT ok. --> daemon edit it is (done before this script runs): /imagePage.
const setup = await post("/imagePage", {
  text: " ",
  tiles: Array.from({ length: TILES }, (_, t) => ({ id: t + 2, x: X0 + t * TILE_W, y: Y0, width: TILE_W, height: TILE_H })),
})
console.log("page setup:", JSON.stringify(setup))
if (!setup.ok) process.exit(1)
await post("/imu", { enable: true, freq: 100 })
await sleep(400)

// paint all tiles once
let frames = tileBmp(null)
for (let t = 0; t < TILES; t++) {
  await post("/imageUpdate", { id: t + 2, width: TILE_W, height: TILE_H, gapMs: 8,
    grayBase64: Buffer.from(frames[t].data).toString("base64") })
}

// physics loop
let x = W / 2, vx = 0, score = 0, inZone = 0, lastText = ""
let lastTiles = new Set()
for (;;) {
  const st = await get("/status").catch(() => null)
  const tilt = st?.imu?.y ?? 0 // lateral gravity component, -1..1
  vx += tilt * 14 // accel
  vx *= 0.92 // friction
  x += vx
  if (x < R + 3) { x = R + 3; vx = -vx * 0.5 }
  if (x > W - R - 3) { x = W - R - 3; vx = -vx * 0.5 }
  // scoring: hold the ball in the center notch
  const centered = Math.abs(x - W / 2) < 14
  inZone = centered ? inZone + 1 : 0
  if (inZone > 0 && inZone % 8 === 0) score++
  const txt = `BALL BALANCE   score ${score}${centered ? "   << HOLD >>" : ""}`
  if (txt !== lastText) { lastText = txt; post("/text", { text: txt }).catch(() => {}) }
  // dirty tiles: where the ball is now + previously painted
  const now = new Set()
  for (let t = 0; t < TILES; t++) if (x >= t * TILE_W - R && x < (t + 1) * TILE_W + R) now.add(t)
  const dirty = new Set([...now, ...lastTiles])
  lastTiles = now
  frames = tileBmp({ x })
  for (const t of dirty) {
    await post("/imageUpdate", { id: t + 2, width: TILE_W, height: TILE_H, gapMs: 8,
      grayBase64: Buffer.from(frames[t].data).toString("base64") }).catch(() => {})
  }
}
