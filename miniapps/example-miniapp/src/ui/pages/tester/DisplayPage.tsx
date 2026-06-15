// Tester page — fire-and-forget actions go through the
// `tester:invoke` channel; background dispatches to session.display.*.

import {useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

// Encode an ImageData's pixels as a base64 4-bit grayscale BMP (no data:
// prefix). The glasses render grayscale, and the phone decodes via iOS
// UIImage / Android BitmapFactory — an uncompressed 4-bit BMP is decoded
// reliably by both, whereas some PNG variants are rejected by ImageIO.
// Each pixel's RGB is reduced to luminance and quantized to one of 16 gray
// levels via a 16-entry grayscale palette; pixels are packed 2 px/byte.
function imageDataToBmp4Bit(img: ImageData): string {
  const {width, height, data} = img
  const rowSize = Math.ceil(width / 8) * 4 // 4 bits/px, 4-byte aligned rows
  const pixelOffset = 118 // 14 (file) + 40 (DIB) + 64 (16-color table)
  const fileSize = pixelOffset + rowSize * height
  const buf = new Uint8Array(fileSize)

  const u16 = (off: number, v: number) => {
    buf[off] = v & 0xff
    buf[off + 1] = (v >>> 8) & 0xff
  }
  const u32 = (off: number, v: number) => {
    buf[off] = v & 0xff
    buf[off + 1] = (v >>> 8) & 0xff
    buf[off + 2] = (v >>> 16) & 0xff
    buf[off + 3] = (v >>> 24) & 0xff
  }

  // File header
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4d // 'M'
  u32(2, fileSize)
  u32(10, pixelOffset)
  // DIB header (BITMAPINFOHEADER)
  u32(14, 40)
  u32(18, width)
  u32(22, height) // positive = bottom-up
  u16(26, 1) // planes
  u16(28, 4) // bits per pixel
  u32(30, 0) // BI_RGB (no compression)
  u32(34, rowSize * height)
  u32(38, 2835) // X px/meter
  u32(42, 2835) // Y px/meter
  u32(46, 16) // colors used
  u32(50, 16) // important colors
  // Color table: 16 grayscale entries (BGRA), level i scaled across 0..255.
  for (let i = 0; i < 16; i++) {
    const off = 54 + i * 4
    const gray = Math.round((i / 15) * 255)
    buf[off] = gray // B
    buf[off + 1] = gray // G
    buf[off + 2] = gray // R
  }

  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4 // RGBA, top-down
    const destRow = pixelOffset + (height - 1 - y) * rowSize // write bottom-up
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4
      // Rec. 601 luma, quantized to 4 bits (0..15).
      const lum = 0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2]
      const level = Math.min(15, lum / 16) | 0
      // Two pixels per byte: even x → high nibble, odd x → low nibble.
      if ((x & 1) === 0) buf[destRow + (x >> 1)] |= level << 4
      else buf[destRow + (x >> 1)] |= level
    }
  }

  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary)
}

// Draw a labeled rectangle to an offscreen canvas and return it as a
// base64 4-bit grayscale BMP (no data: prefix), the glasses-native bitmap format.
function makeBitmap(width: number, height: number, label: string): string {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = "#fff"
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, width - 4, height - 4)
  ctx.fillStyle = "#fff"
  ctx.font = `bold ${Math.round(height / 4)}px sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, width / 2, height / 2)
  return imageDataToBmp4Bit(ctx.getImageData(0, 0, width, height))
}

// The four 100×100 corner containers on the 576×288 display, keyed by rect.
// First press of a corner sends its code (TL/TR/BR/BL); each later press
// re-sends to the same rect with an incrementing count, updating in place.
const CORNERS = [
  {code: "TL", x: 0, y: 0},
  {code: "TR", x: 476, y: 0},
  {code: "BR", x: 476, y: 188},
  {code: "BL", x: 0, y: 188},
] as const

type CornerCode = "TL" | "TR" | "BR" | "BL" | "CE" | "full"

export default function DisplayPage() {
  const navigate = useNavigate()
  // useTester opens a (no-op) subscription so `tester:event {kind:"error"}`
  // from a bad invoke() lands in lastError and surfaces in the UI.
  const {invoke, lastError} = useTester("display")
  const [text, setText] = useState("Hello from MentraJS!")
  // Per-corner press counts. 0 = not yet pressed (first press shows the code).
  const [counts, setCounts] = useState<Record<CornerCode, number>>({
    TL: 0,
    TR: 0,
    BR: 0,
    BL: 0,
    CE: 0,
    full: 0,
  })
  // Synchronous mirror of `counts` so rapid presses (faster than a React
  // re-render) read the up-to-date value instead of a stale render closure,
  // which would otherwise reuse the same count and show a duplicate label.
  const countsRef = useRef(counts)

  const pressCorner = (code: CornerCode, x: number, y: number) => {
    const next = incrementCount(code)
    // First press: just the corner code. Subsequent presses: code + count.
    const label = `${code} ${next}`
    invoke("showBitmapView", [makeBitmap(100, 100, label), {x, y, width: 100, height: 100}]).catch(() => {})
  }

  const incrementCount = (code: CornerCode) => {
    const next = countsRef.current[code] + 1
    countsRef.current = {...countsRef.current, [code]: next}
    setCounts(countsRef.current)
    return next
  }

  return (
    <Shell>
      <MiniappHeader title="session.display" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Render text on the glasses display. Tap a button to invoke the corresponding `session.display.*` method in
          background.
        </p>
        <Label htmlFor="display-text">text</Label>
        <Input id="display-text" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-3 flex flex-col gap-2">
          <Button onClick={() => invoke("showTextWall", [text]).catch(() => {})}>showTextWall(text)</Button>
          <Button onClick={() => invoke("showReferenceCard", ["Title", text]).catch(() => {})}>showReferenceCard(title, text)</Button>
          <Button onClick={() => invoke("showDoubleTextWall", ["Top", text]).catch(() => {})}>showDoubleTextWall(top, bottom)</Button>
        </div>

        <p className="mb-2 mt-5 text-[13px] text-muted-foreground">
          Bitmaps. `showBitmapView(data, options)` accepts optional `x`/`y`/`width`/`height`. On G2 the page tracks up
          to 4 image containers, keyed by rect: a new rect adds a container (evicting the oldest past 4), an existing
          rect updates in place. Each corner button sends its code on first press, then increments a count in place on
          later presses.
        </p>
        <div className="flex flex-row gap-2">
          {CORNERS.map(({code, x, y}) => (
            <Button key={code} onClick={() => pressCorner(code, x, y)} className="w-1/5">
              {code}
              {` ${counts[code]}`}
            </Button>
          ))}
        </div>

        <div className="flex flex-row gap-2 mt-5">
          <Button
            onClick={() => {
              let next = incrementCount("CE")
              invoke("showBitmapView", [makeBitmap(100, 100, `CE ${next}`), {x: 288 - 100 / 2, y: 144 - 100 / 2, width: 100, height: 100}]).catch(() => {})
            }}>
            Center
          </Button>
          <Button
            onClick={() => {
              let next = incrementCount("full")
              invoke("showBitmapView", [
                makeBitmap(288, 144, `full ${next}`),
                {x: 288 - 288 / 2, y: 144 - 144 / 2, width: 288, height: 144},
              ]).catch(() => {})
            }}>
            Large
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <Button
            variant="destructive"
            onClick={() => {
              const zero = {TL: 0, TR: 0, BR: 0, BL: 0, CE: 0, full: 0}
              countsRef.current = zero
              setCounts(zero)
              invoke("clear", []).catch(() => {})
            }}>
            clearDisplay()
          </Button>
        </div>
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}
