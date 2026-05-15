// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useRef, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function InputPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [lastButton, setLastButton] = useState("(none)")
  const [lastTouchAll, setLastTouchAll] = useState<Record<string, unknown> | null>(null)
  const [lastTouchSingle, setLastTouchSingle] = useState<Record<string, unknown> | null>(null)
  const [lastTouchMulti, setLastTouchMulti] = useState<Record<string, unknown> | null>(null)

  const [singleGesture, setSingleGesture] = useState("click")
  const [multiGestures, setMultiGestures] = useState("scroll_top, scroll_bottom")
  const [activeSingle, setActiveSingle] = useState(false)
  const [activeMulti, setActiveMulti] = useState(false)
  const singleUnsubRef = useRef<(() => void) | null>(null)
  const multiUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const unsubs = [
      session.input.onButtonPress((d) =>
        setLastButton(`${d.buttonId} (${d.pressType}) — ${new Date().toLocaleTimeString()}`),
      ),
      session.input.onTouch((d) =>
        setLastTouchAll({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  const toggleSingle = () => {
    if (activeSingle) {
      singleUnsubRef.current?.()
      singleUnsubRef.current = null
      setActiveSingle(false)
      return
    }
    singleUnsubRef.current = session.input.onTouch(singleGesture.trim(), (d) =>
      setLastTouchSingle({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
    )
    setActiveSingle(true)
  }

  const toggleMulti = () => {
    if (activeMulti) {
      multiUnsubRef.current?.()
      multiUnsubRef.current = null
      setActiveMulti(false)
      return
    }
    const gestures = multiGestures.split(",").map((s) => s.trim()).filter(Boolean)
    multiUnsubRef.current = session.input.onTouch(gestures, (d) =>
      setLastTouchMulti({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
    )
    setActiveMulti(true)
  }

  return (
    <Shell>
      <MiniappHeader title="session.input" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Physical controls on the glasses — buttons + touch.
        </p>

        <Row emoji="🔘" label=".onButtonPress(handler)" value={lastButton} />

        <TableRow emoji="👆" label=".onTouch(handler) — all gestures" data={lastTouchAll} />

        <Section emoji="🎯" title=".onTouch(gesture, handler)" subtitle="Single-gesture filter.">
          <Label htmlFor="single-gesture">Gesture</Label>
          <Input id="single-gesture" value={singleGesture} onChange={(e) => setSingleGesture(e.target.value)} />
          <Button className="mt-2" onClick={toggleSingle}>{activeSingle ? "Stop" : "Start"}</Button>
          <div className="mt-2">
            <TableRow emoji="📥" label="Last (filtered)" data={lastTouchSingle} />
          </div>
        </Section>

        <Section
          emoji="🎛️"
          title=".onTouch([g1, g2, …], handler)"
          subtitle="Multi-gesture filter, single subscription."
        >
          <Label htmlFor="multi-gestures">Gestures (comma-separated)</Label>
          <Input id="multi-gestures" value={multiGestures} onChange={(e) => setMultiGestures(e.target.value)} />
          <Button className="mt-2" onClick={toggleMulti}>{activeMulti ? "Stop" : "Start"}</Button>
          <div className="mt-2">
            <TableRow emoji="📥" label="Last (filtered)" data={lastTouchMulti} />
          </div>
        </Section>
      </div>
    </Shell>
  )
}

function Section({
  emoji,
  title,
  subtitle,
  children,
}: {
  emoji: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg">{emoji}</span>
        <span className="font-mono text-sm font-semibold">{title}</span>
      </div>
      {subtitle && <p className="mb-3 text-[12px] text-muted-foreground">{subtitle}</p>}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}
