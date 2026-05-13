// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useCapabilities, useSession} from "@mentra/miniapp/react"
import type {LedColor} from "@mentra/miniapp"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Shell} from "../Shell"

const COLORS: Array<{value: LedColor; className: string}> = [
  {value: "red", className: "bg-red-500"},
  {value: "green", className: "bg-green-500"},
  {value: "blue", className: "bg-blue-500"},
  {value: "orange", className: "bg-orange-500"},
  {value: "white", className: "bg-white text-black"},
]

export default function LedPage() {
  const session = useSession()
  const navigate = useNavigate()
  const caps = useCapabilities()
  const modelName = (caps as Record<string, unknown>)?.modelName as string | undefined
  const isMentraLive = modelName?.toLowerCase().includes("live") ?? false

  const [color, setColor] = useState<LedColor>("green")
  const [ontime, setOntime] = useState("1000")
  const [offtime, setOfftime] = useState("500")
  const [count, setCount] = useState("3")
  const [log, setLog] = useState<string[]>([])

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 10))

  const handleSolid = async () => {
    try {
      await session.led.solid(color, parseInt(ontime) || 1000)
      appendLog(`solid(${color}, ${ontime}ms)`)
    } catch (err) {
      appendLog(`solid error: ${String(err)}`)
    }
  }

  const handleBlink = async () => {
    try {
      await session.led.blink(color, parseInt(ontime) || 500, parseInt(offtime) || 500, parseInt(count) || 3)
      appendLog(`blink(${color}, on=${ontime}, off=${offtime}, count=${count})`)
    } catch (err) {
      appendLog(`blink error: ${String(err)}`)
    }
  }

  const handleOff = async () => {
    try {
      await session.led.turnOff()
      appendLog("turnOff()")
    } catch (err) {
      appendLog(`turnOff error: ${String(err)}`)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.led" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {!isMentraLive && (
          <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-500">
            ⚠️ LED is only supported on Mentra Live. Calls still send but other devices will no-op.
          </div>
        )}

        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <Label className="mb-2 block text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Color
          </Label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => setColor(c.value)}
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 ${c.className} ${
                  color === c.value ? "border-foreground" : "border-transparent"
                }`}
                aria-label={c.value}>
                {color === c.value && <span className="text-sm font-bold">✓</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ontime">On time (ms)</Label>
            <Input id="ontime" value={ontime} onChange={(e) => setOntime(e.target.value)} inputMode="numeric" />
            <Label htmlFor="offtime" className="mt-1">Off time (ms)</Label>
            <Input id="offtime" value={offtime} onChange={(e) => setOfftime(e.target.value)} inputMode="numeric" />
            <Label htmlFor="count" className="mt-1">Count</Label>
            <Input id="count" value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={handleSolid}>Solid</Button>
            <Button variant="outline" onClick={handleBlink}>Blink</Button>
            <Button variant="destructive" onClick={handleOff}>Off</Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Log
          </div>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="font-mono text-[11px] text-foreground/80">{entry}</div>
            ))
          )}
        </div>
      </div>
    </Shell>
  )
}
