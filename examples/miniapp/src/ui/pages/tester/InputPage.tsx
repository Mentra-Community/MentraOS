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
  const {latestByKind} = useTester("input")

  // Pull the most-recent event of each kind out of the log.
  const lastButton = latestByKind("button")
  const lastTouch = latestByKind("touch")

  return (
    <Shell>
      <MiniappHeader title="session.input" onBack={() => navigate("/")} />
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
