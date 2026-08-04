// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useCapabilities, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function GlassesPage() {
  const session = useSession()
  const navigate = useNavigate()
  const caps = useCapabilities()
  const modelName = (caps as Record<string, unknown>)?.modelName as string | undefined
  const isMentraLive = modelName?.toLowerCase().includes("live") ?? false

  const [battery, setBattery] = useState("—")
  const [connection, setConnection] = useState<Record<string, unknown> | null>(null)
  const [log, setLog] = useState<string[]>([])

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 10))

  useEffect(() => {
    const unsubs = [
      session.glasses.onBattery((d) => setBattery(`${d.level}%${d.charging ? " ⚡" : ""}`)),
      session.glasses.onConnection((d) =>
        setConnection({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  const handleWifiAdb = async (enabled: boolean) => {
    try {
      await session.glasses.setWifiAdbState(enabled)
      appendLog(`setWifiAdbState(${enabled})`)
    } catch (err) {
      appendLog(`setWifiAdbState error: ${String(err)}`)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.glasses" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">Hardware-side state of the glasses themselves.</p>

        <Row emoji="🔋" label=".onBattery(handler)" value={battery} />
        <TableRow emoji="🔌" label=".onConnection(handler)" data={connection} />

        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Wi-Fi ADB
          </div>
          {!isMentraLive && (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-500">
              Wi-Fi ADB is only supported on Mentra Live. Calls still send but other devices will no-op.
            </div>
          )}
          <p className="mb-3 text-[13px] text-muted-foreground">
            Toggle wireless debugging on the glasses. Off by default for security.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void handleWifiAdb(true)}>Enable</Button>
            <Button variant="outline" onClick={() => void handleWifiAdb(false)}>
              Disable
            </Button>
          </div>
          {log.length > 0 ? (
            <div className="mt-3 space-y-1">
              {log.map((line) => (
                <p key={line} className="font-mono text-[11px] text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  )
}
