// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function PhonePage() {
  const session = useSession()
  const navigate = useNavigate()

  const [battery, setBattery] = useState("—")
  const [lastNotification, setLastNotification] = useState<Record<string, unknown> | null>(null)
  const [lastDismissed, setLastDismissed] = useState<Record<string, unknown> | null>(null)
  const [lastCalendar, setLastCalendar] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const unsubs = [
      session.phone.onBattery((d) => setBattery(`${d.level}%${d.charging ? " ⚡" : ""}`)),
      session.phone.notifications.on((d) =>
        setLastNotification({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
      session.phone.notifications.onDismissed((d) =>
        setLastDismissed({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
      session.phone.calendar.on((d) =>
        setLastCalendar({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="session.phone" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Phone device-state events. <code className="font-mono">notifications.onDismissed</code> is Android-only;
          subscribing on iOS succeeds but no events fire.
        </p>

        <Row emoji="📱" label=".onBattery(handler)" value={battery} />
        <TableRow emoji="🔔" label=".notifications.on(handler)" data={lastNotification} />
        <TableRow
          emoji="🗑️"
          label=".notifications.onDismissed(handler) — Android only"
          data={lastDismissed}
        />
        <TableRow emoji="📅" label=".calendar.on(handler)" data={lastCalendar} />
      </div>
    </Shell>
  )
}
