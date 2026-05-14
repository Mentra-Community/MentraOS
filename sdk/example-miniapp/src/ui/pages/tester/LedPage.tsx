// Tester page — fire-and-forget RGB LED.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import "../../../shared/channels"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Input} from "../../components/input"
import {Label} from "../../components/label"

export default function LedPage() {
  const navigate = useNavigate()
  const [color, setColor] = useState("#00ff66")
  const [durationMs, setDurationMs] = useState("1000")
  const fire = (method: string, args: unknown[] = []) =>
    mentra.send("tester:fire", {iface: "led", method, args})
  return (
    <Shell>
      <MiniappHeader title="session.led" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Label htmlFor="led-color">color (hex)</Label>
        <Input id="led-color" value={color} onChange={(e) => setColor(e.target.value)} />
        <Label htmlFor="led-duration">duration (ms)</Label>
        <Input
          id="led-duration"
          value={durationMs}
          onChange={(e) => setDurationMs(e.target.value)}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button onClick={() => fire("set", [{color, durationMs: Number(durationMs)}])}>
            set(color, ms)
          </Button>
          <Button onClick={() => fire("blink", [{color, intervalMs: 500}])}>
            blink({"{"}color,500{"}"})
          </Button>
          <Button variant="destructive" onClick={() => fire("off", [])}>
            off()
          </Button>
        </div>
      </div>
    </Shell>
  )
}
