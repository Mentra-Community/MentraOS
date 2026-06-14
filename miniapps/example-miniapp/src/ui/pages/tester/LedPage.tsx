// Tester page — fire-and-forget RGB LED.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"
import {ErrorRow} from "./_TesterRow"

// Mirror of `LedColor` from @mentra/miniapp/background. The UI WebView
// deliberately doesn't import background-only types — keep this list in
// sync with that enum (or, more robustly, type the channel payload in
// `shared/channels.ts`).
const LED_COLORS = ["red", "green", "blue", "orange", "white"] as const
type LedColor = (typeof LED_COLORS)[number]

export default function LedPage() {
  const navigate = useNavigate()
  const {invoke, lastError} = useTester("led")
  const [color, setColor] = useState<LedColor>("green")
  const [durationMs, setDurationMs] = useState("1000")
  const duration = Number(durationMs) || 1000
  return (
    <Shell>
      <MiniappHeader title="session.led" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          RGB LED on Mentra Live. Colors are a fixed enum
          (red / green / blue / orange / white) — the phone maps them
          to per-device LED indices.
        </p>
        <Label>color</Label>
        <div className="mb-3 flex flex-wrap gap-2">
          {LED_COLORS.map((c) => (
            <Button
              key={c}
              variant={c === color ? "default" : "outline"}
              size="sm"
              onClick={() => setColor(c)}>
              {c}
            </Button>
          ))}
        </div>
        <Label htmlFor="led-duration">duration (ms)</Label>
        <Input
          id="led-duration"
          value={durationMs}
          onChange={(e) => setDurationMs(e.target.value)}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button onClick={() => invoke("turnOn", [{color, ontime: duration, count: 1}]).catch(() => {})}>
            turnOn({color}, {duration}ms)
          </Button>
          <Button onClick={() => invoke("solid", [color, duration]).catch(() => {})}>
            solid({color}, {duration})
          </Button>
          <Button onClick={() => invoke("blink", [color, 250, 250, 4]).catch(() => {})}>
            blink({color}, 250, 250, 4)
          </Button>
          <Button variant="destructive" onClick={() => invoke("turnOff", []).catch(() => {})}>
            turnOff()
          </Button>
        </div>
        <ErrorRow event={lastError} />
      </div>
    </Shell>
  )
}
