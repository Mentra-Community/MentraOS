// Tester page — glasses battery + connection + Mentra Live Wi-Fi ADB.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {useChannel} from "../../hooks/useChannel"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function GlassesPage() {
  const navigate = useNavigate()
  const {log, latestByKind, invoke, lastError} = useTester("glasses")
  const snapshot = useChannel("captions:snapshot")
  const modelName = snapshot?.capabilities?.modelName ?? ""
  const isMentraLive = modelName.toLowerCase().includes("live")
  const lastBattery = latestByKind("battery")
  const lastConnection = latestByKind("connection")

  const runWifiAdb = (enabled: boolean) => {
    void invoke("setWifiAdbState", [enabled])
  }

  return (
    <Shell>
      <MiniappHeader title="session.glasses" onBack={() => navigate("/")} />
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

        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Wi-Fi ADB
          </div>
          {!isMentraLive && (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-500">
              Wi-Fi ADB is only supported on Mentra Live. Calls still send but other devices will
              no-op.
            </div>
          )}
          <p className="mb-3 text-[13px] text-muted-foreground">
            Toggle wireless debugging on the glasses. Off by default for security.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => runWifiAdb(true)}>Enable</Button>
            <Button variant="outline" onClick={() => runWifiAdb(false)}>
              Disable
            </Button>
          </div>
          <ErrorRow event={lastError} />
        </div>
      </div>
    </Shell>
  )
}
