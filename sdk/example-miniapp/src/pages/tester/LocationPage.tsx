// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Shell} from "../Shell"
import {TableRow} from "./_TesterRow"

export default function LocationPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [last, setLast] = useState<Record<string, unknown> | null>(null)
  const [count, setCount] = useState(0)

  useEffect(() => {
    const unsub = session.location.onUpdate((d) => {
      setLast({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()})
      setCount((n) => n + 1)
    })
    return () => unsub()
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="session.location" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Phone-side GPS / location stream. Requires <code className="font-mono">LOCATION</code> in miniapp.json.
        </p>

        <TableRow emoji="📍" label=".onUpdate(handler)" data={last} />

        <div className="mt-2 rounded-xl border border-border bg-card p-3">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Updates received
          </div>
          <div className="mt-1 font-mono text-sm">{count}</div>
        </div>
      </div>
    </Shell>
  )
}
