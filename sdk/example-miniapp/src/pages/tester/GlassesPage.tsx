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

export default function GlassesPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [battery, setBattery] = useState("—")
  const [connection, setConnection] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const unsubs = [
      session.glasses.onBattery((d) => setBattery(`${d.level}%${d.charging ? " ⚡" : ""}`)),
      session.glasses.onConnection((d) =>
        setConnection({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="session.glasses" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">Hardware-side state of the glasses themselves.</p>

        <Row emoji="🔋" label=".onBattery(handler)" value={battery} />
        <TableRow emoji="🔌" label=".onConnection(handler)" data={connection} />
      </div>
    </Shell>
  )
}
