// lens-matrix: Matrix rain on the G2 via 20Hz text updates (human-verified
// smooth at 20Hz). Run: node lens-matrix.mjs [fps] [cols] [rows]
const fps = Number(process.argv[2] || 20), COLS = Number(process.argv[3] || 26), ROWS = Number(process.argv[4] || 7)
const post = async (p, body) => (await fetch("http://127.0.0.1:8799" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const GLYPHS = "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇ0123456789Z:・.=*+-<>"
const drops = Array.from({ length: COLS }, () => ({ y: Math.floor(Math.random() * ROWS), len: 3 + Math.floor(Math.random() * 4) }))
const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "))
await post("/text", { text: "MATRIX" }); await sleep(800)
for (;;) {
  for (let c = 0; c < COLS; c++) {
    const d = drops[c]
    grid[d.y % ROWS][c] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    const tail = (d.y - d.len + ROWS * 9) % ROWS
    grid[tail][c] = " "
    if (Math.random() < 0.85) d.y = (d.y + 1) % ROWS
    if (Math.random() < 0.02) d.len = 3 + Math.floor(Math.random() * 4)
  }
  await post("/text", { text: grid.map((r) => r.join("")).join("\n") }).catch(() => {})
  await sleep(1000 / fps)
}
