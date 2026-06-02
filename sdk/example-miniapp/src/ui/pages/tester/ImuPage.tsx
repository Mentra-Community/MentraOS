// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {TableRow} from "./_TesterRow"

export default function ImuPage() {
  const navigate = useNavigate()
  const {latest, log} = useTester("imu")
  return (
    <Shell>
      <MiniappHeader title="session.imu" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Head pose from the glasses IMU.
        </p>
        <TableRow
          emoji="🧭"
          label="latest .onHeadPosition()"
          data={latest ? ((latest.payload as unknown) as Record<string, unknown>) : null}
        />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
