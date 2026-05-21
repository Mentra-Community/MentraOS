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

const TYPES = ["location", "microphone", "camera", "notifications", "calendar"] as const

export default function PermissionsPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [record, setRecord] = useState<Record<string, unknown>>(() => session.permissions.getAll() as unknown as Record<string, unknown>)
  const [updateCount, setUpdateCount] = useState(0)
  const [lastError, setLastError] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const unsubs = [
      session.permissions.onUpdate((perms) => {
        setRecord(perms as unknown as Record<string, unknown>)
        setUpdateCount((n) => n + 1)
      }),
      session.permissions.onPermissionError((err) =>
        setLastError({...(err as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="session.permissions" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Tracks <em>manifest-declared</em> permissions only. <code className="font-mono">.has()</code> returning
          {" "}true means the manifest declared it — <strong>not</strong> that the OS actually granted it. To
          detect grant state, observe whether subscriptions deliver events.
        </p>

        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">📋</span>
            <span className="font-mono text-sm font-semibold">.has(type) per declared type</span>
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-[12px]">
              <tbody>
                {TYPES.map((t, i) => (
                  <tr key={t} className={i % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{t}</td>
                    <td className="break-all px-3 py-1.5 font-mono text-[11px]">
                      {session.permissions.has(t) ? "true" : "false"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <TableRow emoji="📦" label=".getAll()" data={record} />

        <Row
          emoji="🔔"
          label=".onUpdate(handler) — fires count"
          value={String(updateCount)}
          mono
        />

        <TableRow emoji="⚠️" label=".onPermissionError(handler) — last error" data={lastError} />
      </div>
    </Shell>
  )
}
