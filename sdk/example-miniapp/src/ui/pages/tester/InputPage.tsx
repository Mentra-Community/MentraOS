// Tester page — diagnostic surface, ephemeral by design.
// Two-layer port: subscribes to the iface via mentra.send("tester:start", ...)
// instead of calling session.* directly. Background's TesterController
// fans events back via "tester:event".

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function InputPage() {
  const navigate = useNavigate()
  const {log} = useTester("input")

  // Pull the most-recent event of each kind out of the log.
  const lastButton = lastOfKind(log, "button")
  const lastTouch = lastOfKind(log, "touch")

  return (
    <Shell>
      <MiniappHeader title="session.input" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Physical controls on the glasses — buttons + touch. Background's
          TesterController fans events back via `tester:event`.
        </p>
        <Row
          emoji="🔘"
          label=".onButtonPress(handler)"
          value={
            lastButton
              ? `${(lastButton.payload as {buttonId: string}).buttonId} (${(lastButton.payload as {pressType: string}).pressType})`
              : "(no events yet)"
          }
        />
        <TableRow
          emoji="👆"
          label=".onTouch(handler)"
          data={lastTouch ? ((lastTouch.payload as unknown) as Record<string, unknown>) : null}
        />
      </div>
    </Shell>
  )
}

function lastOfKind<T extends {kind: string}>(log: T[], kind: string): T | null {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.kind === kind) return log[i]!
  }
  return null
}
