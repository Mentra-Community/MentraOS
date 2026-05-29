// Tester page — fire-and-forget actions go through the
// `tester:invoke` channel; background dispatches to session.display.*.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

// Draw a labeled rectangle to an offscreen canvas and return its base64 PNG
// (no data: prefix). The glasses-side SGC converts it to the native format.
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
  return canvas.toDataURL("image/png").split(",")[1]
}

export default function DisplayPage() {
  const navigate = useNavigate()
  // useTester opens a (no-op) subscription so `tester:event {kind:"error"}`
  // from a bad invoke() lands in lastError and surfaces in the UI.
  const {invoke, lastError} = useTester("display")
  const [text, setText] = useState("Hello from MentraJS!")
  // Counter so the "reuse" button sends a visibly different image to the same rect each tap.
  const [reuseN, setReuseN] = useState(0)
  return (
    <Shell>
      <MiniappHeader title="session.display" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Render text on the glasses display. Tap a button to invoke the
          corresponding `session.display.*` method in background.
        </p>
        <Label htmlFor="display-text">text</Label>
        <Input id="display-text" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-3 flex flex-col gap-2">
          <Button onClick={() => invoke("showTextWall", [text])}>showTextWall(text)</Button>
          <Button onClick={() => invoke("showReferenceCard", ["Title", text])}>
            showReferenceCard(title, text)
          </Button>
          <Button onClick={() => invoke("showDoubleTextWall", ["Top", text])}>
            showDoubleTextWall(top, bottom)
          </Button>
        </div>

        <p className="mb-2 mt-5 text-[13px] text-muted-foreground">
          Bitmaps. `showBitmapView(data, options)` accepts optional `x`/`y`/`width`/`height`.
          On G2 the page tracks up to 4 image containers, keyed by rect: a new rect adds a
          container (evicting the oldest past 4), an existing rect updates in place. Omit options
          for the default 100×100 top-left container.
        </p>
        <div className="flex flex-col gap-2">
          {/* Default rect: 100×100 top-left (no options). */}
          <Button onClick={() => invoke("showBitmapView", [makeBitmap(100, 100, "TL")])}>
            showBitmapView — default 100×100 top-left
          </Button>
          {/* New container: 100×100 top-right. */}
          <Button
            onClick={() =>
              invoke("showBitmapView", [
                makeBitmap(100, 100, "TR"),
                {x: 476, y: 0, width: 100, height: 100},
              ])
            }>
            showBitmapView — 100×100 top-right
          </Button>
          {/* New container: 100×100 bottom-right. */}
          <Button
            onClick={() =>
              invoke("showBitmapView", [
                makeBitmap(100, 100, "BR"),
                {x: 476, y: 188, width: 100, height: 100},
              ])
            }>
            showBitmapView — 100×100 bottom-right
          </Button>
          {/* Reuse demo: re-send a fresh label to the default top-left rect — updates in place. */}
          <Button
            onClick={() => {
              setReuseN((n) => n + 1)
              invoke("showBitmapView", [makeBitmap(100, 100, `#${reuseN + 1}`)])
            }}>
            showBitmapView — reuse top-left (update in place)
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <Button variant="destructive" onClick={() => invoke("clearView", [])}>
            clearView()
          </Button>
        </div>
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}
