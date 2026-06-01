// Tester page — glasses battery + connection.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {TableRow} from "./_TesterRow"

export default function GlassesPage() {
  const navigate = useNavigate()
  const {log} = useTester("glasses")
  const lastBattery = [...log].reverse().find((e) => e.kind === "battery")
  const lastConnection = [...log].reverse().find((e) => e.kind === "connection")
  return (
    <Shell>
      <MiniappHeader title="session.glasses" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Glasses-side telemetry — battery + connection state.
        </p>
        <TableRow
          emoji="🔋"
          label="last .onBattery()"
          data={lastBattery ? ((lastBattery.payload as unknown) as Record<string, unknown>) : null}
        />
        <TableRow
          emoji="🔗"
          label="last .onConnection()"
          data={
            lastConnection ? ((lastConnection.payload as unknown) as Record<string, unknown>) : null
          }
        />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
