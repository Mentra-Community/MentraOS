// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function LocationPage() {
  const navigate = useNavigate()
  const {latestByKind, log, fire, lastError} = useTester("location")

  // Both .onUpdate() (kind="update") and .getOnce() (kind="result", with
  // the same shape nested under payload.result) describe the same thing:
  // "the latest known location". Prefer whichever happened most recently
  // by scanning the log once.
  const latestFix = (() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const ev = log[i]!
      if (ev.kind === "update") return ev.payload as Record<string, unknown>
      if (ev.kind === "result") {
        const r = (ev.payload as {result?: unknown}).result
        if (r && typeof r === "object") return r as Record<string, unknown>
      }
    }
    return null
  })()

  return (
    <Shell>
      <MiniappHeader title="session.location" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          GPS coordinates streamed from the phone.
        </p>
        <TableRow emoji="📍" label="latest fix" data={latestFix} />
        <Button className="mt-3" onClick={() => fire("getOnce", [])}>
          Request a one-shot fix
        </Button>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
