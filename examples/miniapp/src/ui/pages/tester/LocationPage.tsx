// Tester page — diagnostic surface, ephemeral by design.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function LocationPage() {
  const navigate = useNavigate()
  const {log, invoke, lastError} = useTester("location")

  // `getOnce()` resolves through the `tester:invoke` RPC reply — its value
  // comes back as the return of `invoke()`, NOT as a streamed `tester:event`.
  // So capture it in local state; the continuous `.onUpdate()` stream still
  // arrives as `kind="update"` log events. Render each source in its own
  // table so it's always clear which path produced which fix.
  const [oneShotFix, setOneShotFix] = useState<Record<string, unknown> | null>(null)

  const latestStreamed = (() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const ev = log[i]!
      if (ev.kind === "update") return ev.payload as Record<string, unknown>
    }
    return null
  })()

  const requestOneShot = async () => {
    try {
      const result = (await invoke("getOnce", [])) as Record<string, unknown>
      setOneShotFix(result)
    } catch {
      // Error is surfaced via lastError → ErrorRow; the catch also prevents
      // an unhandled promise rejection on a failed location request.
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.location" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          GPS coordinates streamed from the phone.
        </p>
        <TableRow emoji="📡" label="streamed onUpdate()" data={latestStreamed} />
        <TableRow emoji="🎯" label="one-shot getOnce()" data={oneShotFix} />
        <Button className="mt-1" onClick={requestOneShot}>
          Request single location
        </Button>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
